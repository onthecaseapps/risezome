import { describe, it, expect } from 'vitest';
import { formatReplaySummary } from '../../app/(authed)/debug/live-mic/_replay-summary';
import type { ReplayUtterance } from '../../app/(authed)/debug/live-mic/_replay-source';
import type { StageRecord, UtteranceTrace } from '../../app/(authed)/debug/live-mic/_pipeline-model';

function u(over: Partial<ReplayUtterance> & { utteranceId: string }): ReplayUtterance {
  return { text: 'how many github issues are there', speaker: 'S1', startMs: 0, ...over };
}

function trace(utteranceId: string, stages: StageRecord[], priorContext: string[] = []): UtteranceTrace {
  return { traceId: `t_${utteranceId}`, utteranceId, meetingId: 'm1', priorContext, stages };
}

// A grounded RAG run that lost the skill route (the motivating bug shape).
const ragStages: StageRecord[] = [
  { stage: 'heuristic-gate', status: 'ran', decision: 'clearly_substantive', latencyMs: 3 },
  { stage: 'router', status: 'ran', decision: 'fired', reason: 'tool_shaped — classifying in parallel', latencyMs: 2 },
  { stage: 'skill', status: 'ran', decision: 'none', reason: 'not_tool_intent', data: { intent: 'rag' }, latencyMs: 5 },
  { stage: 'emit', status: 'ran', data: { cards: 3 }, latencyMs: 8 },
  { stage: 'reveal', status: 'ran', decision: 'revealed', data: { citations: 2 }, latencyMs: 12 },
];

// A skill that routed correctly.
const skillStages: StageRecord[] = [
  { stage: 'heuristic-gate', status: 'ran', decision: 'clearly_substantive', latencyMs: 3 },
  { stage: 'skill', status: 'ran', decision: 'kept', reason: 'github_count → source[0]', data: { intent: 'tool', skillName: 'github_count', args: { state: 'open' } }, latencyMs: 6 },
  { stage: 'reveal', status: 'ran', decision: 'revealed', data: { citations: 1 }, latencyMs: 10 },
];

describe('formatReplaySummary (U5)', () => {
  it('serializes every utterance in order with outcome + route + reason + context', () => {
    const utts = [
      u({ utteranceId: 'a', text: 'how many github issues are there', startMs: 0 }),
      u({ utteranceId: 'b', text: 'what is the count of github issues', startMs: 5000 }),
    ];
    const traces = new Map<string, UtteranceTrace>([
      ['a', trace('a', ragStages, ['rolling summary', 'earlier turn'])],
      ['b', trace('b', skillStages)],
    ]);
    const out = formatReplaySummary(utts, traces);

    expect(out).toContain('2 utterances');
    // Order preserved.
    expect(out.indexOf('[1]')).toBeLessThan(out.indexOf('[2]'));
    // RAG route surfaced with the classifier intent (the bug signal).
    expect(out).toContain('RAG — router chose rag (not_tool_intent)');
    // Correct skill route surfaced with the chosen skill.
    expect(out).toContain('SKILL github_count — kept');
    // Prior context included.
    expect(out).toContain('prior context (2):');
    expect(out).toContain('· rolling summary');
    // Speaker + clock.
    expect(out).toContain('S1 @ 0:00');
    expect(out).toContain('@ 0:05');
  });

  it('lists a gated/suppressed utterance with its suppression reason (not omitted)', () => {
    const gated: StageRecord[] = [
      { stage: 'heuristic-gate', status: 'short_circuited', decision: 'skip', reason: 'clearly_filler', latencyMs: 0 },
    ];
    const out = formatReplaySummary([u({ utteranceId: 'g', text: 'yeah' })], new Map([['g', trace('g', gated)]]));
    expect(out).toContain('text: yeah');
    expect(out).toContain('suppressed at: heuristic-gate — skip (clearly_filler)');
  });

  it('excludes bulky fields (no raw embeddings) but keeps route reason + prior context', () => {
    const out = formatReplaySummary(
      [u({ utteranceId: 'a' })],
      new Map([['a', trace('a', ragStages, ['ctx line'])]]),
    );
    expect(out).not.toMatch(/embedding|vector|\[0\.\d/);
    expect(out).toContain('route:');
    expect(out).toContain('· ctx line');
  });

  it('an utterance sent without a trace is still listed', () => {
    const out = formatReplaySummary([u({ utteranceId: 'x', text: 'orphan' })], new Map());
    expect(out).toContain('text: orphan');
    expect(out).toContain('no trace');
  });

  it('empty replay → a clear summary, not an empty string', () => {
    const out = formatReplaySummary([], new Map());
    expect(out).toContain('No utterances were replayed.');
    expect(out.length).toBeGreaterThan(0);
  });
});
