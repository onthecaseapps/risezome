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
    this.#onChange = (): void => {
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
    let embedded;
    try {
      embedded = await this.#embedder.embed({
        items: [{ text: windowText.text, domain: 'text' }],
      });
    } catch (err) {
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
    } catch (err) {
      this.#inflight -= 1;
      this.emit('error', err as Error);
      return;
    }
    const retrieveEndAt = this.#now();

    let emitted = 0;
    for (const r of results) {
      if (this.#session.hasSurfaced(r.doc.id)) continue;
      const card: CardEvent = {
        cardId: `c_${randomBytes(6).toString('hex')}`,
        docId: r.doc.id,
        source: r.doc.source,
        type: r.doc.type,
        title: r.doc.title,
        snippet: r.snippet,
        score: r.score,
        metadata: { authors: r.doc.authors },
        surfacedAt: this.#now(),
        triggeredBy,
        traceId,
        ...(utteranceId !== undefined && { utteranceId }),
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
