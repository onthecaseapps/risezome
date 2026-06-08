import { describe, expect, it } from 'vitest';
import { skipReasonToTrace } from '../../src/debug/gate-skip-trace.js';

const ctx = {
  traceId: 'tr1',
  utteranceId: 'u1',
  meetingId: 'm1',
  priorContext: ['an earlier turn'],
  latencyMs: 7,
};

describe('skipReasonToTrace (U2)', () => {
  it('maps each pre-pipeline gate skip to its trace stage', () => {
    const cases: [string, string][] = [
      ['below_utterance_threshold', 'threshold'],
      ['cooldown', 'cooldown'],
      ['question_ceiling', 'cooldown'],
      ['duplicate_question', 'question-dedup'],
      ['empty_query', 'empty-query'],
    ];
    for (const [reason, stage] of cases) {
      const evt = skipReasonToTrace(reason, ctx);
      expect(evt, reason).not.toBeNull();
      expect(evt!.stages[0]!.stage).toBe(stage);
      expect(evt!.stages[0]!.status).toBe('short_circuited');
      expect(evt!.stages[0]!.decision).toBe('skip');
      expect(evt!.stages[0]!.reason).toBe(reason); // precise reason kept (e.g. question_ceiling)
    }
  });

  it('returns null for a fired utterance (undefined reason) — the core emits the real trace', () => {
    expect(skipReasonToTrace(undefined, ctx)).toBeNull();
  });

  it('returns null for a core-originated skip (already traced by the sink)', () => {
    expect(skipReasonToTrace('duplicate_answer_sources', ctx)).toBeNull();
    expect(skipReasonToTrace('filler', ctx)).toBeNull();
    expect(skipReasonToTrace('embed_failed', ctx)).toBeNull();
  });

  it('returns null for an unknown reason (defensive)', () => {
    expect(skipReasonToTrace('something_new', ctx)).toBeNull();
  });

  it('carries the trace context (ids + priorContext + latency) onto the event', () => {
    const evt = skipReasonToTrace('cooldown', ctx)!;
    expect(evt.type).toBe('trace');
    expect(evt.traceId).toBe('tr1');
    expect(evt.utteranceId).toBe('u1');
    expect(evt.meetingId).toBe('m1');
    expect(evt.priorContext).toEqual(['an earlier turn']);
    expect(evt.stages[0]!.latencyMs).toBe(7);
  });

  it('defaults latencyMs to 0 when omitted', () => {
    const { latencyMs: _omit, ...noLatency } = ctx;
    void _omit;
    expect(skipReasonToTrace('cooldown', noLatency)!.stages[0]!.latencyMs).toBe(0);
  });
});
