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
  /** True when the matched chunk is the doc's generated summary (U6): the body
   *  leads with the summary excerpt and the UI flags it as a condensed view of
   *  the original source. */
  readonly isSummary?: boolean;
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
  /** The transcript utterance that triggered this synthesis (U6). Lets the
   *  UI show the question above the answer. Optional/null for events from
   *  before this field existed. */
  readonly triggerUtteranceId?: string | null;
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

/**
 * One additional supporting source on a synthesis answer: retrieved,
 * validated as supporting by the synthesizer (the `ALSO:` protocol line),
 * but not cited in the answer body. cardId is resolved the same way as
 * citations (sourceCardIds[rank - 1]) before persisting/broadcasting.
 */
export interface AdditionalSource {
  readonly rank: number;
  readonly cardId: string;
}

export interface SynthesisDoneEvent {
  readonly synthesisId: string;
  readonly stopReason: string;
  readonly citations: readonly SynthesisCitation[];
  readonly usage: SynthesisUsageStats;
  readonly ttftMs: number;
  readonly latencyMs: number;
  /** Full final answer text. When present the reducer REPLACES the
   *  delta-accumulated text with it, so a dropped synthesisDelta
   *  self-heals at done. Absent on events from before this field. */
  readonly text?: string;
  /** Resolved additional supporting sources (broadcast/persisted path).
   *  Absent when the synthesizer marked none. */
  readonly additionalSources?: readonly AdditionalSource[];
  /** Rank-only variant carried by the dev WS path, where the client holds
   *  sourceCardIds from synthesisStart and resolves rank → card locally.
   *  Absent when the synthesizer marked none. */
  readonly additionalSourceRanks?: readonly number[];
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

/**
 * One transcript utterance on the live/review surfaces. A partial and its
 * later final share the same `utteranceId` (Recall identity is
 * `participantId::startMs`); the reducer merges them by id, last-revision-wins,
 * with a final never downgraded back to a partial. `speaker` is the Recall
 * participant name (null when the platform didn't attribute it).
 */
export interface TranscriptUtterance {
  readonly utteranceId: string;
  readonly text: string;
  readonly speaker: string | null;
  readonly isFinal: boolean;
  readonly startMs: number;
  /** Last word's end time (ms from call start). The gap from one utterance's
   *  endMs to the next's startMs is the silence between them — a large gap is a
   *  pause, which the transcript renders as a paragraph break. */
  readonly endMs: number;
  readonly revision: number;
}

export type ServerMessage =
  | { type: 'hello'; version: string }
  | { type: 'card'; card: CardEvent }
  | { type: 'cardUpdated'; update: CardUpdated }
  | { type: 'cardRetracted'; retracted: CardRetracted }
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

export type KnownSource = 'github' | 'jira' | 'slack' | 'code' | 'trello' | 'confluence';
export type KnownType = 'issue' | 'pull-request' | 'code' | 'doc' | 'card' | 'page';

export const KNOWN_SOURCES: readonly KnownSource[] = ['github', 'jira', 'slack', 'code', 'trello', 'confluence'];
export const KNOWN_TYPES: readonly KnownType[] = ['issue', 'pull-request', 'code', 'doc', 'card', 'page'];
