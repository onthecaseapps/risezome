import { describe, it, expect } from 'vitest';
import {
  formatReplaySummary,
  type ReplayUtteranceOutput,
} from '../../app/(authed)/debug/live-mic/_replay-summary';
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

  it('does NOT report a grounded question-lane utterance as "suppressed at: heuristic-gate" (bypass is not a stop)', () => {
    const questionLaneGrounded: StageRecord[] = [
      // The question lane bypasses the relevance gate — short_circuited but NOT a
      // suppression; the utterance proceeds and grounds.
      { stage: 'heuristic-gate', status: 'short_circuited', decision: 'bypassed', reason: 'question_lane', latencyMs: 0 },
      { stage: 'reveal', status: 'ran', decision: 'revealed', data: { citations: 4 }, latencyMs: 12 },
    ];
    const out = formatReplaySummary(
      [u({ utteranceId: 'q', text: 'is the transcript working' })],
      new Map([['q', trace('q', questionLaneGrounded)]]),
    );
    expect(out).toContain('outcome: grounded');
    expect(out).not.toContain('suppressed at:'); // the bypass must not read as a suppression
  });

  it('shows a near-duplicate question as a skip (KTD4 adapter parity), with its reason', () => {
    const qdedup: StageRecord = {
      stage: 'question-dedup',
      status: 'short_circuited',
      latencyMs: 0,
      decision: 'skip',
      reason: 'duplicate_question',
    };
    const out = formatReplaySummary(
      [u({ utteranceId: 'q', text: 'how many github issues are there' })],
      new Map([['q', trace('q', [qdedup])]]),
    );
    expect(out).toContain('outcome: skip');
    expect(out).toContain('suppressed at: question-dedup — skip (duplicate_question)');
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

  it('renders a scoped retrieval-scope header when given a meeting scope', () => {
    const out = formatReplaySummary(
      [u({ utteranceId: 'a' })],
      new Map([['a', trace('a', ragStages)]]),
      { scoped: true, meetingId: '6675501a' },
    );
    expect(out).toContain('retrieval scope: scoped to meeting 6675501a');
  });

  it('renders an unscoped retrieval-scope header for a no-meeting (file) replay', () => {
    const out = formatReplaySummary(
      [u({ utteranceId: 'a' })],
      new Map([['a', trace('a', ragStages)]]),
      { scoped: false, meetingId: null },
    );
    expect(out).toContain('retrieval scope: unscoped (no meeting)');
  });

  it('omits the scope header when no scope is provided (back-compat)', () => {
    const out = formatReplaySummary([u({ utteranceId: 'a' })], new Map([['a', trace('a', ragStages)]]));
    expect(out).not.toContain('retrieval scope:');
  });

  it('shows a cooldown-suppressed utterance as a skip with its suppression gate', () => {
    const cooldown: StageRecord = {
      stage: 'cooldown',
      status: 'short_circuited',
      latencyMs: 0,
      decision: 'skip',
      reason: 'cooldown',
    };
    const out = formatReplaySummary(
      [u({ utteranceId: 'c', text: 'how many github issues are there' })],
      new Map([['c', trace('c', [cooldown])]]),
    );
    expect(out).toContain('outcome: skip');
    expect(out).toContain('suppressed at: cooldown — skip (cooldown)');
  });

  describe('full gate ledger + cards + answer (copy-summary completeness)', () => {
    it('renders the gate-by-gate ledger with codes, stage names, statuses, and reached rows', () => {
      const out = formatReplaySummary(
        [u({ utteranceId: 'a', text: 'how many github issues are there' })],
        new Map([['a', trace('a', ragStages, ['rolling summary'])]]),
      );
      // The ledger header + the catalog rows that actually ran.
      expect(out).toContain('gates:');
      expect(out).toContain('S05 Relevance gate [PASS]');
      expect(out).toContain('S06 Router (parallel) [PASS]');
      expect(out).toContain('S13 Router collect + skill [PASS]');
      expect(out).toContain('S17 Reveal [PASS]');
      // Latency from the wire record is carried through.
      expect(out).toMatch(/Reveal \[PASS\].*\(12ms\)/);
      // Notreached rows downstream of the terminal stop are NOT dumped (noise cut).
      expect(out).not.toContain('[—]');
    });

    it('renders a derived PRE gate (cooldown) as an N/A info row when it did not suppress', () => {
      const out = formatReplaySummary(
        [u({ utteranceId: 'a' })],
        new Map([['a', trace('a', ragStages)]]),
      );
      // Threshold + cooldown ran in the adapter without suppressing → info rows.
      expect(out).toContain('PRE Utterance gate [N/A]');
      expect(out).toContain('PRE Cooldown [N/A]');
    });

    it('renders a real SKIP ledger row for a suppressing gate (question-dedup)', () => {
      const qdedup: StageRecord = {
        stage: 'question-dedup',
        status: 'short_circuited',
        latencyMs: 1,
        decision: 'skip',
        reason: 'duplicate_question',
      };
      const out = formatReplaySummary(
        [u({ utteranceId: 'q' })],
        new Map([['q', trace('q', [qdedup])]]),
      );
      expect(out).toContain('PRE Question dedup [SKIP] duplicate_question (1ms)');
    });

    it('lists retrieved cards with rank, source, title, and scores', () => {
      const outputs = new Map<string, ReplayUtteranceOutput>([
        [
          'a',
          {
            cards: [
              { rank: 1, source: 'github', title: 'Open issues report', score: 0.8123, distance: 0.21 },
              { rank: 2, source: 'transcript', title: 'Standup notes' },
            ],
          },
        ],
      ]);
      const out = formatReplaySummary(
        [u({ utteranceId: 'a' })],
        new Map([['a', trace('a', ragStages)]]),
        undefined,
        outputs,
      );
      expect(out).toContain('retrieved cards (2):');
      expect(out).toContain('[1] github · Open issues report score=0.8123 dist=0.210');
      expect(out).toContain('[2] transcript · Standup notes');
    });

    it('includes the synthesized answer text for a grounded utterance', () => {
      const outputs = new Map<string, ReplayUtteranceOutput>([
        ['a', { answer: 'There are 47 open GitHub issues.' }],
      ]);
      const out = formatReplaySummary(
        [u({ utteranceId: 'a' })],
        new Map([['a', trace('a', ragStages)]]),
        undefined,
        outputs,
      );
      expect(out).toContain('answer: There are 47 open GitHub issues.');
    });

    it('clips a very long answer rather than dumping the whole body', () => {
      const long = 'x'.repeat(900);
      const outputs = new Map<string, ReplayUtteranceOutput>([['a', { answer: long }]]);
      const out = formatReplaySummary(
        [u({ utteranceId: 'a' })],
        new Map([['a', trace('a', ragStages)]]),
        undefined,
        outputs,
      );
      expect(out).toContain('… (+300 chars)');
      expect(out).not.toContain('x'.repeat(900));
    });

    it('omits the cards/answer blocks when no output is provided (back-compat)', () => {
      const out = formatReplaySummary([u({ utteranceId: 'a' })], new Map([['a', trace('a', ragStages)]]));
      expect(out).not.toContain('retrieved cards');
      expect(out).not.toContain('answer:');
      // But the gate ledger is still always present.
      expect(out).toContain('gates:');
    });
  });
});

describe('timing visibility (question lane + timeline)', () => {
  // A QUESTION-lane grounded run with full timing data — the shape that used to
  // render only PRE+S05 rows (the bypass was treated as a terminal stop).
  const questionStages: StageRecord[] = [
    { stage: 'empty-query', status: 'ran', latencyMs: 0, atMs: 0, decision: 'pass' },
    { stage: 'heuristic-gate', status: 'short_circuited', latencyMs: 0, atMs: 0, decision: 'bypassed', reason: 'question_lane' },
    { stage: 'llm-judge', status: 'skipped', latencyMs: 0, atMs: 0, reason: 'not_routed' },
    { stage: 'embed', status: 'ran', latencyMs: 1, atMs: 0, decision: 'reused', data: { reused: true, adapterEmbedMs: 240 } },
    { stage: 'hybrid-search', status: 'ran', latencyMs: 1851, atMs: 250, data: { hits: [], count: 4, rpcMs: 400, rerankMs: 1400 } },
    { stage: 'emit', status: 'ran', latencyMs: 176, atMs: 2280, decision: 'emitted', data: { emitted: 4, cards: 4 } },
    { stage: 'synthesis', status: 'ran', latencyMs: 8000, atMs: 2460, decision: 'generated', data: { streamed: true, ttftMs: 900, firstProseMs: 1400, chars: 400, sources: 4 } },
    { stage: 'reveal', status: 'ran', decision: 'revealed', data: { citations: 3 }, latencyMs: 3, atMs: 10463 },
  ];

  it('renders the full ledger for a question-lane run (no truncation at the bypass)', () => {
    const out = formatReplaySummary(
      [u({ utteranceId: 'q1' })],
      new Map([['q1', trace('q1', questionStages)]]),
    );
    expect(out).toContain('S08 Hybrid search');
    expect(out).toContain('S14 Synthesis');
    expect(out).toContain('(1851ms @t+250ms)');
  });

  it('emits a derived timing line: search split, cards@, ttft, first prose, done', () => {
    const out = formatReplaySummary(
      [u({ utteranceId: 'q1' })],
      new Map([['q1', trace('q1', questionStages)]]),
    );
    expect(out).toContain('timing: ');
    expect(out).toContain('embed 240ms (adapter)');
    expect(out).toContain('search 1851ms (rpc 400ms + rerank 1400ms)');
    expect(out).toContain('cards@t+2456ms'); // emit at 2280 + 176
    expect(out).toContain('synth ttft 900ms');
    expect(out).toContain('first prose@t+3860ms'); // synth at 2460 + firstProse 1400
    expect(out).toContain('synth done@t+10460ms'); // synth at 2460 + 8000
  });

  it('reports a not-routed judge honestly (no more "judge ran")', () => {
    const out = formatReplaySummary(
      [u({ utteranceId: 'q1' })],
      new Map([['q1', trace('q1', questionStages)]]),
    );
    expect(out).toContain('judge not run (not_routed)');
    expect(out).not.toContain('judge ran');
  });
});
