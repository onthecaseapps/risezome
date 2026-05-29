export type CardTrigger = 'window' | 'question' | 'question-provisional';

export interface CardEvent {
  readonly cardId: string;
  readonly docId: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly snippet: string;
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

export interface SynthesisDoneEvent {
  readonly synthesisId: string;
  readonly stopReason: string;
  readonly citations: readonly number[];
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
