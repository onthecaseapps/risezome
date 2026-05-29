export type CardTrigger = 'window' | 'question' | 'question-provisional';

export interface CardEvent {
  readonly cardId: string;
  readonly docId: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
  readonly surfacedAt: number;
  readonly triggeredBy: CardTrigger;
  readonly utteranceId?: string;
  readonly traceId: string;
  // Origin URL for the underlying doc (GitHub blob URL, issue URL, PR URL,
  // etc.). For code chunks we append a `#L{start}-L{end}` anchor so the link
  // jumps to the cited range. Absent when the connector did not provide one.
  readonly url?: string;
  // 1-indexed position within the current retrieval batch. Lets the HUD show
  // "Top match" / "Match" labels instead of a raw RRF percent, which reads
  // as "2% confidence" to humans even when the doc is the strongest result.
  readonly rank: number;
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

export interface RetrievalTrace {
  readonly traceId: string;
  readonly utteranceId?: string;
  readonly windowFlushAt: number;
  readonly embedStartAt: number;
  readonly embedEndAt: number;
  readonly retrieveStartAt: number;
  readonly retrieveEndAt: number;
  readonly cardEmitAt: number;
  readonly cardCount: number;
}

// Code the HUD receives in `synthesisError`. The full set covers refusal
// (LLM emitted the sentinel), rate-limiting, the Anthropic kind taxonomy
// from SynthesisProviderError, 'aborted' (superseded by a new flush), and
// 'unknown' as a catchall. The HUD treats every code the same way: drop
// the synthesis card.
export type SynthesisErrorCode =
  | 'refused'
  | 'rate-limited'
  | 'aborted'
  | 'auth-error'
  | 'bad-request'
  | 'network-error'
  | 'overloaded'
  | 'server-error'
  | 'request-too-large'
  | 'unknown';

export type SynthesisRetractedReason = 'source-retracted' | 'meeting-ended' | 'manual-dismiss';

export interface SynthesisStart {
  readonly synthesisId: string;
  readonly sourceCardIds: readonly string[];
  readonly traceId: string;
}

export interface SynthesisDelta {
  readonly synthesisId: string;
  readonly delta: string;
}

export interface SynthesisUsageStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface SynthesisDone {
  readonly synthesisId: string;
  readonly stopReason: string;
  readonly citations: readonly number[];
  readonly usage: SynthesisUsageStats;
  /** Time-to-first-token: ms from synthesizer.synthesize() call to first textDelta. */
  readonly ttftMs: number;
  /** Total latency: ms from synthesizer.synthesize() call to done chunk. */
  readonly latencyMs: number;
}

export interface SynthesisError {
  readonly synthesisId: string;
  readonly code: SynthesisErrorCode;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

export interface SynthesisRetracted {
  readonly synthesisId: string;
  readonly reason: SynthesisRetractedReason;
}

export type ClassifierIntent = 'rag' | 'tool';
export type ClassifierSkippedReason = 'heuristic-no-match' | 'no-classifier' | 'no-consent';
export type SkillFailureCode =
  | 'unknown-skill'
  | 'execution-error'
  | 'aborted'
  | 'rate-limit'
  | 'auth-error'
  | 'not-found'
  | 'unknown';
export type SkillResultKind = 'count' | 'list' | 'detail';

export interface ClassifierStart {
  readonly traceId: string;
}

export interface ClassifierDoneUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface ClassifierDone {
  readonly traceId: string;
  readonly intent: ClassifierIntent;
  readonly skillName?: string;
  readonly latencyMs: number;
  readonly usage?: ClassifierDoneUsage;
}

export interface ClassifierSkipped {
  readonly traceId: string;
  readonly reason: ClassifierSkippedReason;
}

export interface ClassifierError {
  readonly traceId: string;
  readonly code: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
}

export interface SkillStart {
  readonly traceId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface SkillDone {
  readonly traceId: string;
  readonly name: string;
  readonly latencyMs: number;
  readonly resultShape: SkillResultKind;
}

export interface SkillFailed {
  readonly traceId: string;
  readonly name?: string;
  readonly code: SkillFailureCode;
  readonly message?: string;
}

// --- Utterance-relevance pre-classifier events ---

export type RelevanceGate = 'heuristic' | 'llm' | 'llm-cached';

export interface RelevanceSkip {
  readonly traceId: string;
  readonly utterance: string;
  readonly gate: RelevanceGate;
  readonly reason: string;
  readonly confidence?: number;
  readonly utteranceId?: string;
}

export interface RelevanceLlmStart {
  readonly traceId: string;
  readonly utterance: string;
  readonly utteranceId?: string;
}

// Emitted on every LLM call regardless of decision. This is the
// calibration signal: it makes the surface/skip distribution greppable
// in daemon logs so the threshold env var becomes tunable.
export interface RelevanceClassified {
  readonly traceId: string;
  readonly utterance: string;
  readonly decision: 'surface' | 'skip';
  readonly confidence: number | null;
  readonly latencyMs: number;
  readonly utteranceId?: string;
}

export interface RelevanceLlmError {
  readonly traceId: string;
  readonly code: string;
  readonly message?: string;
  readonly utteranceId?: string;
}

export interface RetrievalPipelineEvents {
  card: [CardEvent];
  cardUpdated: [CardUpdated];
  cardRetracted: [CardRetracted];
  trace: [RetrievalTrace];
  error: [Error];
  synthesisStart: [SynthesisStart];
  synthesisDelta: [SynthesisDelta];
  synthesisDone: [SynthesisDone];
  synthesisError: [SynthesisError];
  synthesisRetracted: [SynthesisRetracted];
  classifierStart: [ClassifierStart];
  classifierDone: [ClassifierDone];
  classifierSkipped: [ClassifierSkipped];
  classifierError: [ClassifierError];
  skillStart: [SkillStart];
  skillDone: [SkillDone];
  skillFailed: [SkillFailed];
  relevanceSkip: [RelevanceSkip];
  relevanceLlmStart: [RelevanceLlmStart];
  relevanceClassified: [RelevanceClassified];
  relevanceLlmError: [RelevanceLlmError];
}
