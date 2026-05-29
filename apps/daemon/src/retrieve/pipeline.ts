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
import { isToolShaped } from '../router/heuristic.js';
import {
  type Classifier,
  ClassifierProviderError,
} from '../router/contract.js';
import { type SkillRegistry } from '../skills/registry.js';
import { type Skill, formatAsSource } from '../skills/contract.js';
import type { SynthesisSource } from '../synthesize/contract.js';
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
  /**
   * Heuristic-gated classifier. When absent, the router is disabled and
   * the pipeline behaves exactly as the synthesis-only baseline.
   */
  readonly classifier?: Classifier;
  /**
   * Registry of skills the classifier may invoke. Both classifier AND
   * skillRegistry with size > 0 are required for the router to fire.
   */
  readonly skillRegistry?: SkillRegistry;
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
  readonly #classifier: Classifier | undefined;
  readonly #skillRegistry: SkillRegistry | undefined;

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
    this.#classifier = options.classifier;
    this.#skillRegistry = options.skillRegistry;
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

    // --- Router gate -------------------------------------------------------
    // Heuristic-gated classifier: matches on the most-recent finalized
    // utterance (NOT the windowText, which may carry stale tool-shaped
    // phrases from earlier in the meeting). When the heuristic fires AND the
    // classifier + registry + consent are all configured, the classifier
    // runs in parallel with the embed+retrieve below. The synthesizer call
    // (later) waits for both before deciding which sources to pass.
    //
    // Cards from the retrieval branch still emit synchronously inside the
    // existing loop, so the HUD's raw-card TTFT is unchanged.
    const latestUtterance = this.#window?.latestFinalUtteranceText() ?? '';
    let classifierPromise: ReturnType<Classifier['classify']> | null = null;
    let classifierController: AbortController | null = null;
    let classifierStartedAt = 0;
    if (this.#classifier !== undefined && this.#skillRegistry !== undefined && this.#skillRegistry.size() > 0) {
      if (latestUtterance.length > 0 && isToolShaped(latestUtterance)) {
        if (this.#consentCheck !== undefined && !this.#consentCheck()) {
          this.emit('classifierSkipped', { traceId, reason: 'no-consent' });
        } else {
          classifierController = new AbortController();
          classifierStartedAt = this.#now();
          this.emit('classifierStart', { traceId });
          classifierPromise = this.#classifier.classify(
            { utterance: latestUtterance, registry: this.#skillRegistry },
            classifierController.signal,
          );
          // Swallow unhandled-rejection noise; the await later collects it.
          classifierPromise.catch(() => undefined);
        }
      } else {
        // Heuristic miss — no classifier event; the absence of classifierStart
        // is itself the signal that the router didn't fire this flush.
      }
    } else if (this.#classifier === undefined && latestUtterance.length > 0 && isToolShaped(latestUtterance)) {
      // Heuristic flagged but no classifier configured — record the skip.
      this.emit('classifierSkipped', { traceId, reason: 'no-classifier' });
    }

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

    // --- Collect classifier result + execute skill (if any) ---------------
    let toolSource: SynthesisSource | null = null;
    if (classifierPromise !== null) {
      try {
        const result = await classifierPromise;
        const latencyMs = this.#now() - classifierStartedAt;
        const doneEvent: import('./contract.js').ClassifierDone = {
          traceId,
          intent: result.intent,
          latencyMs,
          ...(result.intent === 'tool' && { skillName: result.skillName }),
        };
        this.emit('classifierDone', doneEvent);

        if (result.intent === 'tool') {
          const skill: Skill | undefined = this.#skillRegistry?.lookup(result.skillName);
          if (skill === undefined) {
            this.emit('skillFailed', {
              traceId,
              name: result.skillName,
              code: 'unknown-skill',
            });
          } else {
            this.emit('skillStart', {
              traceId,
              name: result.skillName,
              args: result.args,
            });
            const skillStartedAt = this.#now();
            try {
              const skillResult = await skill.handler(result.args, {
                db: this.#db,
                ...(classifierController !== null && { signal: classifierController.signal }),
                now: this.#now,
              });
              // Discard the result if a newer flush has aborted the controller —
              // abort gates result usage, not the SQL itself (which has already
              // run synchronously inside the handler).
              if (classifierController?.signal.aborted === true) {
                this.emit('skillFailed', {
                  traceId,
                  name: result.skillName,
                  code: 'aborted',
                });
              } else {
                this.emit('skillDone', {
                  traceId,
                  name: result.skillName,
                  latencyMs: this.#now() - skillStartedAt,
                  resultShape: skillResult.kind,
                });
                toolSource = formatAsSource(skillResult, result.skillName, result.args);
              }
            } catch (err) {
              this.emit('skillFailed', {
                traceId,
                name: result.skillName,
                code: 'execution-error',
                message: (err as Error).message,
              });
            }
          }
        }
      } catch (err) {
        // Classifier failure: emit classifierError, fall through to RAG-only.
        if (err instanceof ClassifierProviderError) {
          this.emit('classifierError', {
            traceId,
            code: err.kind,
            message: err.message,
            ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
          });
        } else if (err instanceof Error && err.name === 'AbortError') {
          // Aborted — silent, just like synthesis aborts.
        } else {
          this.emit('classifierError', {
            traceId,
            code: 'unknown',
            message: (err as Error).message,
          });
        }
      }
    }

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
      void this.#maybeSynthesize(emittedCards, windowText.text, traceId, toolSource);
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
    toolSource: SynthesisSource | null,
  ): Promise<void> {
    if (this.#synthesizer === undefined) return;
    const cardSources = emittedCards.slice(0, this.#synthesisTopN).map((c) => ({
      rank: c.rank,
      title: c.title === '' ? c.docId : c.title,
      text: c.snippet,
    }));
    // Tool result, when present, takes source[0]; cards follow. The
    // synthesizer's existing prompt cites by 1-indexed position in the
    // array, so [1] is the tool result and [2..N] are the cards.
    const sources = toolSource !== null ? [toolSource, ...cardSources] : cardSources;
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
