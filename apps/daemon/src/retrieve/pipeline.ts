import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { Embedder } from '../embed/contract.js';
import { hybridSearch } from '../corpus/query.js';
import { hasEntityLikeToken } from '../corpus/text-heuristics.js';
import type { TranscriptWindow, WindowText } from '../transcript/window.js';
import type { MeetingSession } from '../meeting/session.js';
import type {
  CardEvent,
  CardTrigger,
  RetrievalPipelineEvents,
  RetrievalTrace,
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
}

const DEFAULT_WINDOW_SECONDS = 30;
const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_MIN_SCORE = 0.012; // Roughly 1 / (60+20) — anything weaker than rank-20 from a single ranker.
const DEFAULT_TOP_K = 3;

export class RetrievalPipeline extends EventEmitter<RetrievalPipelineEvents> {
  readonly #db: DatabaseType;
  readonly #embedder: Embedder;
  readonly #session: MeetingSession;
  readonly #windowSeconds: number;
  readonly #debounceMs: number;
  readonly #minScore: number;
  readonly #topK: number;
  readonly #now: () => number;

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
  }
}

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
