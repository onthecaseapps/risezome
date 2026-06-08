// Debug-side gate-skip → trace translation (KTD1).
//
// `maybeRetrieveAndEmit` returns `{ emitted, skipped? }` where `skipped` is a
// reason string. When the PROD ADAPTER suppresses an utterance BEFORE the core
// runs (throttle / near-duplicate), no core trace is emitted — so the debug page
// would show "no trace" for a suppressed utterance. This pure helper maps such a
// pre-pipeline skip reason into a single-stage `trace` WS event so the existing
// trace panel + replay summary surface WHY the utterance produced nothing.
//
// Kept on the DEBUG side (not inside the adapter) so the prod retrieval path
// stays trace-free. Reasons that originate INSIDE runPipeline (e.g.
// `duplicate_answer_sources`, `filler`, `embed_failed`) already emit their own
// core trace via the sink — those return null here.

import type { PipelineStage } from '../pipeline/contract.js';

/** Map each PRE-pipeline adapter skip reason to the trace stage that represents
 *  it. Reasons not in this map come from the core (already traced) → null. */
const PRE_PIPELINE_SKIP_STAGE: Readonly<Record<string, PipelineStage>> = {
  below_utterance_threshold: 'threshold',
  cooldown: 'cooldown',
  // The per-minute / per-meeting ceiling falls back to the cooldown gate; show
  // it on the cooldown row but keep the precise reason for the detail line.
  question_ceiling: 'cooldown',
  duplicate_question: 'question-dedup',
  empty_query: 'empty-query',
};

export interface GateSkipTraceContext {
  readonly traceId: string;
  readonly utteranceId: string;
  readonly meetingId: string;
  /** The effective prior-context window the adapter saw (for the trace panel). */
  readonly priorContext: readonly string[];
  readonly latencyMs?: number;
}

/** The `trace` WS event payload for a pre-pipeline gate skip (shape mirrors the
 *  core's PipelineTrace plus the `type` tag the page keys on). */
export interface GateSkipTraceEvent {
  readonly type: 'trace';
  readonly traceId: string;
  readonly utteranceId: string;
  readonly meetingId: string;
  readonly priorContext: readonly string[];
  readonly stages: readonly {
    readonly stage: PipelineStage;
    readonly status: 'short_circuited';
    readonly decision: 'skip';
    readonly reason: string;
    readonly latencyMs: number;
  }[];
}

/**
 * Translate an adapter `skipped` reason into a trace event, or null when the
 * reason isn't a pre-pipeline gate (fired = undefined, or a core-originated skip
 * that already traced itself). Pure.
 */
export function skipReasonToTrace(
  reason: string | undefined,
  ctx: GateSkipTraceContext,
): GateSkipTraceEvent | null {
  if (reason === undefined) return null; // fired — the core emits the real trace
  const stage = PRE_PIPELINE_SKIP_STAGE[reason];
  if (stage === undefined) return null; // core-originated skip — already traced
  return {
    type: 'trace',
    traceId: ctx.traceId,
    utteranceId: ctx.utteranceId,
    meetingId: ctx.meetingId,
    priorContext: ctx.priorContext,
    stages: [
      {
        stage,
        status: 'short_circuited',
        decision: 'skip',
        reason,
        latencyMs: ctx.latencyMs ?? 0,
      },
    ],
  };
}
