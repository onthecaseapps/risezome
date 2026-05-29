import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Embedder } from '../embed/contract.js';
import { hybridSearch } from '../corpus/query.js';
import { hasEntityLikeToken } from '../corpus/text-heuristics.js';
import type { TranscriptWindow, WindowText } from '../transcript/window.js';
import type { MeetingSession } from '../meeting/session.js';
import {
  SynthesisProviderError,
  SynthesisRateLimitError,
  type Synthesizer,
  type SynthesisInput,
} from '../synthesize/contract.js';
import { parseSynthesisOutput, REFUSAL_SENTINEL } from '../synthesize/prompt.js';
import { log } from '../cli/util.js';
import type {
  CardEvent,
  CardRetracted,
  CardTrigger,
  RetrievalPipelineEvents,
  RetrievalTrace,
  SynthesisErrorCode,
} from './contract.js';

export interface RetrievalPipelineOptions {
  readonly db: DatabaseType;
  readonly embedder: Embedder;
  readonly session: MeetingSession;
  readonly windowSeconds?: number;
  readonly debounceMs?: number;
  readonly minScore?: number;
  readonly topK?: number;
  readonly now?: () => number;
  // --- Synthesis options ---
  /**
   * Streaming LLM synthesizer. When absent, no synthesis runs and the
   * pipeline behaves exactly as it did before U4 — raw cards only.
   */
  readonly synthesizer?: Synthesizer;
  /**
   * Sync gate evaluated at flush time. When it returns false, no
   * synthesis call is made. Existing usage: closure over hasConsent(db,
   * 'anthropic'). Re-checked on every flush so revocation takes effect
   * on the next debounced batch.
   */
  readonly consentCheck?: () => boolean;
  /**
   * Minimum RRF score on the top emitted card required to trigger
   * synthesis. Below this threshold, the HUD shows raw cards only.
   * Default 0.025 (≈ top-1 in at least one ranker).
   */
  readonly minSynthesisScore?: number;
  /**
   * Number of top cards passed to the synthesizer as numbered sources.
   * Default 3.
   */
  readonly synthesisTopN?: number;
  readonly synthesisMaxTokens?: number;
}

const DEFAULT_WINDOW_SECONDS = 30;
const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_MIN_SCORE = 0.012; // Roughly 1 / (60+20) — anything weaker than rank-20 from a single ranker.
const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SYNTHESIS_SCORE = 0.025;
const DEFAULT_SYNTHESIS_TOP_N = 3;

export class RetrievalPipeline extends EventEmitter<RetrievalPipelineEvents> {
  readonly #db: DatabaseType;
  readonly #embedder: Embedder;
  readonly #session: MeetingSession;
  readonly #windowSeconds: number;
  readonly #debounceMs: number;
  readonly #minScore: number;
  readonly #topK: number;
  readonly #now: () => number;
  readonly #synthesizer: Synthesizer | undefined;
  readonly #consentCheck: (() => boolean) | undefined;
  readonly #minSynthesisScore: number;
  readonly #synthesisTopN: number;
  readonly #synthesisMaxTokens: number | undefined;

  #window: TranscriptWindow | null = null;
  #onChange: ((window: WindowText) => void) | null = null;
  #debounceTimer: NodeJS.Timeout | null = null;
  #pendingTraceContext: { windowFlushAt: number; utteranceId?: string } | null = null;
  #inflight = 0;

  constructor(options: RetrievalPipelineOptions) {
    super();
    this.#db = options.db;
    this.#embedder = options.embedder;
    this.#session = options.session;
    this.#windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.#topK = options.topK ?? DEFAULT_TOP_K;
    this.#now = options.now ?? Date.now;
    this.#synthesizer = options.synthesizer;
    this.#consentCheck = options.consentCheck;
    this.#minSynthesisScore = options.minSynthesisScore ?? DEFAULT_MIN_SYNTHESIS_SCORE;
    this.#synthesisTopN = options.synthesisTopN ?? DEFAULT_SYNTHESIS_TOP_N;
    this.#synthesisMaxTokens = options.synthesisMaxTokens;
  }

  attachWindow(window: TranscriptWindow): void {
    if (this.#window !== null) this.detach();
    this.#window = window;
    this.#onChange = (wt): void => {
      // eslint-disable-next-line no-console
      console.log(`[pipeline.debug] windowChanged textLen=${String(wt.text.length)} utterances=${String(wt.utteranceCount)}`);
      this.#schedule();
    };
    window.on('windowChanged', this.#onChange);
  }

  detach(): void {
    if (this.#window !== null && this.#onChange !== null) {
      this.#window.off('windowChanged', this.#onChange);
    }
    this.#window = null;
    this.#onChange = null;
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
  }

  inflight(): number {
    return this.#inflight;
  }

  async runOnce(trigger: CardTrigger = 'window', utteranceId?: string): Promise<void> {
    if (this.#window === null) return;
    const windowText = this.#window.windowText(this.#windowSeconds);
    if (windowText.text.trim().length === 0) return;
    await this.#evaluate(windowText, trigger, utteranceId, this.#now());
  }

  #schedule(): void {
    if (this.#debounceTimer !== null) clearTimeout(this.#debounceTimer);
    // Abort the in-flight synthesis (if any) before scheduling a new flush —
    // the next utterance has superseded the previous question, so the
    // half-streamed answer would be obsolete by the time it lands.
    const active = this.#session.getActiveSynthesis();
    if (active !== null && !active.controller.signal.aborted) {
      log('info', 'synthesis.aborted', { synthesisId: active.synthesisId });
      try {
        active.controller.abort();
      } catch {
        // already aborted
      }
    }
    const flushAt = this.#now();
    this.#pendingTraceContext = { windowFlushAt: flushAt };
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#flush();
    }, this.#debounceMs);
  }

  async #flush(): Promise<void> {
    if (this.#window === null) return;
    const windowText = this.#window.windowText(this.#windowSeconds);
    // eslint-disable-next-line no-console
    console.log(`[pipeline.debug] flush textLen=${String(windowText.text.length)} trimmedLen=${String(windowText.text.trim().length)}`);
    if (windowText.text.trim().length === 0) return;
    const ctx = this.#pendingTraceContext ?? { windowFlushAt: this.#now() };
    this.#pendingTraceContext = null;
    await this.#evaluate(windowText, 'window', undefined, ctx.windowFlushAt);
  }

  async #evaluate(
    windowText: WindowText,
    triggeredBy: CardTrigger,
    utteranceId: string | undefined,
    windowFlushAt: number,
  ): Promise<void> {
    const traceId = `t_${randomBytes(6).toString('hex')}`;
    this.#inflight += 1;
    const embedStartAt = this.#now();
    // eslint-disable-next-line no-console
    console.log(`[pipeline.debug] embed.start trace=${traceId} chars=${String(windowText.text.length)} preview="${windowText.text.slice(0, 80).replace(/\n/g, ' ')}"`);
    let embedded;
    try {
      embedded = await this.#embedder.embed({
        items: [{ text: windowText.text, domain: 'text' }],
      });
      // eslint-disable-next-line no-console
      console.log(`[pipeline.debug] embed.ok trace=${traceId} dim=${String(embedded.dimension)}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[pipeline.debug] embed.err trace=${traceId} message=${(err as Error).message}`);
      this.#inflight -= 1;
      this.emit('error', err as Error);
      return;
    }
    const embedEndAt = this.#now();
    const vector = embedded.vectors[0]?.vector;
    if (vector === undefined) {
      this.#inflight -= 1;
      return;
    }

    const retrieveStartAt = this.#now();
    let results;
    try {
      results = hybridSearch(this.#db, windowText.text, vector, {
        limit: this.#topK,
        minScore: this.#minScore,
        embeddingDim: this.#embedder.dimension,
      });
      // eslint-disable-next-line no-console
      console.log(`[pipeline.debug] retrieve.ok trace=${traceId} results=${String(results.length)} minScore=${String(this.#minScore)}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(`[pipeline.debug] retrieve.err trace=${traceId} message=${(err as Error).message}`);
      this.#inflight -= 1;
      this.emit('error', err as Error);
      return;
    }
    const retrieveEndAt = this.#now();

    let emitted = 0;
    let rank = 0;
    const emittedCards: CardEvent[] = [];
    for (const r of results) {
      if (this.#session.hasSurfaced(r.doc.id)) continue;
      rank += 1;
      const url = buildCardUrl(r.doc.url, r.snippet);
      const card: CardEvent = {
        cardId: `c_${randomBytes(6).toString('hex')}`,
        docId: r.doc.id,
        source: r.doc.source,
        type: r.doc.type,
        title: r.doc.title,
        snippet: r.snippet,
        score: r.score,
        rank,
        metadata: { authors: r.doc.authors },
        surfacedAt: this.#now(),
        triggeredBy,
        traceId,
        ...(utteranceId !== undefined && { utteranceId }),
        ...(url !== null && { url }),
      };
      this.#session.recordSurfaced(card);
      this.emit('card', card);
      emittedCards.push(card);
      emitted += 1;
    }

    const cardEmitAt = this.#now();
    const traceRecord: RetrievalTrace = {
      traceId,
      windowFlushAt,
      embedStartAt,
      embedEndAt,
      retrieveStartAt,
      retrieveEndAt,
      cardEmitAt,
      cardCount: emitted,
      ...(utteranceId !== undefined && { utteranceId }),
    };
    this.emit('trace', traceRecord);
    this.#inflight -= 1;

    // Synthesis gate — fire-and-forget after raw cards have already shipped.
    // Gate requires: at least one newly emitted card this flush, a
    // synthesizer configured, consent granted, and the top card's RRF
    // score above the threshold. Log every skip with the reason so the
    // calibration question ("are we gating too aggressively?") is
    // answerable from the daemon log.
    if (this.#synthesizer === undefined) {
      // Silent — caller logged synthesis.disabled at startup; no per-flush noise.
    } else if (emittedCards.length === 0) {
      // Distinguish "retrieval returned nothing" from "retrieval returned hits
      // but every one was already surfaced earlier this meeting." The
      // latter is dedup working — same docs would just re-render duplicates
      // in the HUD and re-bill an LLM call for context the user already saw.
      const reason = results.length === 0 ? 'no-results' : 'all-already-surfaced';
      log('info', 'synthesis.skipped', { reason, traceId, retrievedCount: results.length });
    } else if (this.#consentCheck !== undefined && !this.#consentCheck()) {
      log('info', 'synthesis.skipped', { reason: 'no-consent', traceId });
    } else if (emittedCards[0]!.score < this.#minSynthesisScore) {
      log('info', 'synthesis.skipped', {
        reason: 'below-threshold',
        topScore: emittedCards[0]!.score,
        threshold: this.#minSynthesisScore,
        traceId,
      });
    } else {
      void this.#maybeSynthesize(emittedCards, windowText.text, traceId);
    }
  }

  // Fire-and-forget streaming synthesis. The caller never awaits this;
  // any error throws into the iterator and is converted to a
  // synthesisError event so the HUD can drop the synthesis card while
  // raw cards stand alone.
  async #maybeSynthesize(
    emittedCards: readonly CardEvent[],
    utterance: string,
    traceId: string,
  ): Promise<void> {
    if (this.#synthesizer === undefined) return;
    const sources = emittedCards.slice(0, this.#synthesisTopN).map((c) => ({
      rank: c.rank,
      title: c.title === '' ? c.docId : c.title,
      text: c.snippet,
    }));
    const sourceCardIds = emittedCards.slice(0, this.#synthesisTopN).map((c) => c.cardId);
    const synthesisId = `syn_${randomBytes(6).toString('hex')}`;
    const controller = new AbortController();

    const input: SynthesisInput = {
      utterance,
      sources,
      ...(this.#synthesisMaxTokens !== undefined && { maxTokens: this.#synthesisMaxTokens }),
    };

    this.#session.recordSynthesis({
      synthesisId,
      sourceCardIds,
      controller,
      startedAt: this.#now(),
    });

    this.emit('synthesisStart', {
      synthesisId,
      sourceCardIds,
      traceId,
    });

    let accumulatedText = '';
    const callStartedAt = this.#now();
    let firstDeltaAt: number | null = null;
    try {
      for await (const chunk of this.#synthesizer.synthesize(input, controller.signal)) {
        switch (chunk.type) {
          case 'start':
            // No-op; start was emitted to the HUD before the synthesizer call.
            continue;
          case 'textDelta':
            if (firstDeltaAt === null) firstDeltaAt = this.#now();
            accumulatedText += chunk.delta;
            this.emit('synthesisDelta', { synthesisId, delta: chunk.delta });
            continue;
          case 'done': {
            const doneAt = this.#now();
            const parsed = parseSynthesisOutput(accumulatedText, sources.length);
            if (parsed.isRefusal) {
              this.emit('synthesisError', { synthesisId, code: 'refused' });
              this.#session.clearSynthesis(synthesisId);
            } else {
              const citedCardIds = parsed.citations
                .map((n) => sourceCardIds[n - 1])
                .filter((id): id is string => typeof id === 'string');
              this.#session.setSynthesisCitations(synthesisId, citedCardIds);
              this.emit('synthesisDone', {
                synthesisId,
                stopReason: chunk.stopReason,
                citations: parsed.citations,
                usage: {
                  inputTokens: chunk.usage.inputTokens,
                  outputTokens: chunk.usage.outputTokens,
                  cacheReadTokens: chunk.usage.cacheReadTokens,
                  cacheCreationTokens: chunk.usage.cacheCreationTokens,
                },
                ttftMs: firstDeltaAt !== null ? firstDeltaAt - callStartedAt : doneAt - callStartedAt,
                latencyMs: doneAt - callStartedAt,
              });
              // Do NOT clear — the synthesis stays in the session map so the
              // retract cascade can find it later. Cleared on meeting end
              // (session.clear), explicit retract, or new schedule abort.
            }
            return;
          }
        }
      }
      // Stream ended without `done` — treat as unknown error.
      this.emit('synthesisError', { synthesisId, code: 'unknown', message: 'stream ended without done' });
      this.#session.clearSynthesis(synthesisId);
    } catch (err) {
      this.#session.clearSynthesis(synthesisId);
      if (isAbortError(err)) {
        // Aborted by a new schedule — silent; the next synthesis fires on the new window.
        return;
      }
      const errorEvent = mapSynthesisError(err, synthesisId);
      this.emit('synthesisError', errorEvent);
    }
  }

  /**
   * Public retract entry point. Emits cardRetracted and cascades a
   * synthesisRetracted for any synthesis that cited the retracted card.
   * This is the canonical way to retract — emitting cardRetracted
   * directly via this.emit would skip the cascade and leave synthesis
   * citing a card that no longer exists in the HUD.
   */
  retractCard(retracted: CardRetracted): void {
    this.emit('cardRetracted', retracted);
    const synthesisIds = this.#session.getSynthesesCiting(retracted.cardId);
    for (const synthesisId of synthesisIds) {
      this.emit('synthesisRetracted', { synthesisId, reason: 'source-retracted' });
      try {
        this.#session.getActiveSynthesis()?.controller.abort();
      } catch {
        // already aborted
      }
      this.#session.clearSynthesis(synthesisId);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError')
    || (err instanceof Error && err.name === 'AbortError')
  );
}

function mapSynthesisError(
  err: unknown,
  synthesisId: string,
): {
  synthesisId: string;
  code: SynthesisErrorCode;
  message?: string;
  retryAfterMs?: number;
} {
  if (err instanceof SynthesisRateLimitError) {
    return {
      synthesisId,
      code: 'rate-limited',
      message: err.message,
      ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
    };
  }
  if (err instanceof SynthesisProviderError) {
    return { synthesisId, code: err.kind, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { synthesisId, code: 'unknown', message };
}

// Expose to tests / future callers
export { REFUSAL_SENTINEL };

export function shouldRunFtsLeg(text: string): boolean {
  return hasEntityLikeToken(text);
}

// Code chunks embed their location as `// path:start-end\n…` at the head of
// the snippet. If we recognize that shape, deep-link straight to the cited
// lines on GitHub by appending `#L{start}-L{end}`. For docs without that
// header (issues, PRs, markdown) we return the doc URL untouched.
const SNIPPET_LOCATION = /^\/\/\s+\S+:(\d+)-(\d+)\s*\r?\n/;

export function buildCardUrl(docUrl: string | null | undefined, snippet: string): string | null {
  if (typeof docUrl !== 'string' || docUrl.length === 0) return null;
  const m = SNIPPET_LOCATION.exec(snippet);
  if (m === null) return docUrl;
  const start = m[1];
  const end = m[2];
  if (start === undefined || end === undefined) return docUrl;
  // GitHub `blob/HEAD/...` URLs accept `#L{start}-L{end}` anchors for range
  // highlight. The page-anchor is the same for any host that uses this
  // convention (Gitea, sourcegraph), so we apply it broadly.
  return `${docUrl}#L${start}-L${end}`;
}
