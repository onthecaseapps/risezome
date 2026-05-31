/**
 * HUD types — the WS message union plus the card/synthesis shapes the
 * daemon sends. Mirrors `apps/hud/src/types.ts` (HEAD) verbatim; the
 * landing-page demo had a simplified `DemoCard` shape that has been
 * replaced by the production `CardEvent` here.
 */

export type CardTrigger = 'window' | 'question' | 'question-provisional';

export interface CardEvent {
  readonly cardId: string;
  readonly docId: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  /** Truncated preview (400 chars). Used in compact card surfaces and
   *  the placeholder source-title line. */
  readonly snippet: string;
  /** Full chunk text the synthesizer saw. Substrate for the click-
   *  citation → expand → highlight-quote UX. Optional to keep
   *  backward compat with pre-deploy serialized cards that only carry
   *  `snippet`; new cards always populate `body`. */
  readonly body?: string;
  readonly score: number;
  readonly rank: number;
  readonly metadata: Record<string, unknown>;
  readonly surfacedAt: number;
  readonly triggeredBy: CardTrigger;
  readonly utteranceId?: string;
  readonly traceId: string;
  readonly url?: string;
}

export interface CardUpdated {
  readonly cardId: string;
  readonly score?: number;
  readonly triggeredBy?: CardTrigger;
  readonly metadata?: Record<string, unknown>;
}

export interface CardRetracted {
  readonly cardId: string;
  readonly reason: 'verifier-downgraded' | 'meeting-ended' | 'manual-dismiss';
}

export interface GapEvent {
  readonly gapId: string;
  readonly meetingId: string;
  readonly question: string;
  readonly contextWindow: string;
  readonly createdAt: number;
}

export type SynthesisErrorCode =
  | 'refused'
  | 'rate-limited'
  | 'auth-error'
  | 'bad-request'
  | 'network-error'
  | 'overloaded'
  | 'server-error'
  | 'request-too-large'
  | 'unknown';

export interface SynthesisStartEvent {
  readonly synthesisId: string;
  readonly sourceCardIds: readonly string[];
  readonly traceId: string;
}

export interface SynthesisDeltaEvent {
  readonly synthesisId: string;
  readonly delta: string;
}

export interface SynthesisUsageStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * One citation occurrence in a synthesis answer. Per-occurrence:
 * the same source cited three times yields three entries, each with
 * its own quote. cardId is the resolved cardId for `rank` (the
 * synthesizer-side parser only knows rank; the bot-worker resolves
 * cardId via sourceCardIds[rank - 1] before persisting).
 */
export interface SynthesisCitation {
  readonly rank: number;
  readonly cardId: string;
  /** Character offset of the [N…] token in accumulated_text. */
  readonly position: number;
  /** Verbatim quote the LLM emitted for this citation. Undefined when
   *  Claude misformatted as bare [N] without a quote payload. */
  readonly quote?: string;
}

export interface SynthesisDoneEvent {
  readonly synthesisId: string;
  readonly stopReason: string;
  readonly citations: readonly SynthesisCitation[];
  readonly usage: SynthesisUsageStats;
  readonly ttftMs: number;
  readonly latencyMs: number;
}

export interface SynthesisErrorEvent {
  readonly synthesisId: string;
  readonly code: SynthesisErrorCode;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

export interface SynthesisRetractedEvent {
  readonly synthesisId: string;
  readonly reason: 'source-retracted' | 'meeting-ended' | 'manual-dismiss';
}

export type ServerMessage =
  | { type: 'hello'; version: string }
  | { type: 'card'; card: CardEvent }
  | { type: 'cardUpdated'; update: CardUpdated }
  | { type: 'cardRetracted'; retracted: CardRetracted }
  | { type: 'gap'; gap: GapEvent }
  | { type: 'status'; mode: 'idle' | 'capturing' | 'processing' }
  | { type: 'meetingStarted'; meetingId: string }
  | { type: 'meetingEnded'; meetingId: string }
  | ({ type: 'synthesisStart' } & SynthesisStartEvent)
  | ({ type: 'synthesisDelta' } & SynthesisDeltaEvent)
  | ({ type: 'synthesisDone' } & SynthesisDoneEvent)
  | ({ type: 'synthesisError' } & SynthesisErrorEvent)
  | ({ type: 'synthesisRetracted' } & SynthesisRetractedEvent);

// Narrowed source/type unions used by the presentation components for
// the chip palette and glyph mapping. CardEvent.source/type are
// `string` (whatever the daemon emits) — these capture the subset the
// HUD knows how to style and provide explicit fallbacks for unknowns.

export type KnownSource = 'github' | 'jira' | 'slack' | 'code';
export type KnownType = 'issue' | 'pull-request' | 'code' | 'doc';

export const KNOWN_SOURCES: readonly KnownSource[] = ['github', 'jira', 'slack', 'code'];
export const KNOWN_TYPES: readonly KnownType[] = ['issue', 'pull-request', 'code', 'doc'];
