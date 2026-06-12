import { describe, it, expect } from 'vitest';
import {
  indexTrace,
  buildLedger,
  deriveOutcome,
  stageDetailRows,
  type TraceEvent,
  type StageRecord,
} from '../../app/(authed)/debug/live-mic/_pipeline-model';

function traceEvent(over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    type: 'trace',
    traceId: 't1',
    utteranceId: 'u1',
    meetingId: 'm1',
    stages: [],
    ...over,
  };
}

describe('indexTrace — prior context (U4/KTD6)', () => {
  it('stores the priorContext carried on the trace event', () => {
    const ctx = ['rolling summary', 'an earlier turn'];
    const map = indexTrace(new Map(), traceEvent({ priorContext: ctx }));
    expect(map.get('u1')?.priorContext).toEqual(ctx);
  });

  it('defaults priorContext to [] for an event without the field (older trace)', () => {
    const map = indexTrace(new Map(), traceEvent());
    expect(map.get('u1')?.priorContext).toEqual([]);
  });

  it('the latest trace for an utterance wins (re-traced on revision)', () => {
    let map = indexTrace(new Map(), traceEvent({ priorContext: ['first'] }));
    map = indexTrace(map, traceEvent({ priorContext: ['second'] }));
    expect(map.get('u1')?.priorContext).toEqual(['second']);
  });
});

describe('question-dedup outcome (KTD4 adapter parity)', () => {
  const qdedup: StageRecord = {
    stage: 'question-dedup',
    status: 'short_circuited',
    latencyMs: 0,
    decision: 'skip',
    reason: 'duplicate_question',
  };

  it('a question-dedup short-circuit reads as a skip outcome (not pending)', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [qdedup] }));
    const outcome = deriveOutcome(map.get('u1')!);
    expect(outcome.type).toBe('skip');
    expect(outcome.sub).toContain('near-duplicate');
  });

  it('renders the question-dedup ledger row with a SKIP status and stops downstream rows', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [qdedup] }));
    const ledger = buildLedger(map.get('u1')!);
    const row = ledger.find((r) => r.id === 'question-dedup')!;
    expect(row.status).toBe('skip');
    expect(ledger.find((r) => r.id === 'reveal')!.status).toBe('notreached');
  });
});

describe('pre-pipeline gate outcomes (KTD1 adapter parity)', () => {
  const cooldown: StageRecord = {
    stage: 'cooldown',
    status: 'short_circuited',
    latencyMs: 0,
    decision: 'skip',
    reason: 'cooldown',
  };
  const ceiling: StageRecord = {
    stage: 'cooldown',
    status: 'short_circuited',
    latencyMs: 0,
    decision: 'skip',
    reason: 'question_ceiling',
  };
  const threshold: StageRecord = {
    stage: 'threshold',
    status: 'short_circuited',
    latencyMs: 0,
    decision: 'skip',
    reason: 'below_utterance_threshold',
  };

  it('a cooldown short-circuit reads as a skip outcome (not pending)', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [cooldown] }));
    const outcome = deriveOutcome(map.get('u1')!);
    expect(outcome.type).toBe('skip');
    expect(outcome.sub).toContain('cooldown');
  });

  it('the question-ceiling variant of cooldown reads as a skip with a ceiling sub', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [ceiling] }));
    const outcome = deriveOutcome(map.get('u1')!);
    expect(outcome.type).toBe('skip');
    expect(outcome.sub).toContain('ceiling');
  });

  it('renders the cooldown ledger row SKIP and stops downstream rows', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [cooldown] }));
    const ledger = buildLedger(map.get('u1')!);
    const row = ledger.find((r) => r.id === 'cooldown')!;
    expect(row.status).toBe('skip');
    expect(ledger.find((r) => r.id === 'reveal')!.status).toBe('notreached');
  });

  it('a threshold short-circuit reads as a skip outcome (not pending)', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [threshold] }));
    const outcome = deriveOutcome(map.get('u1')!);
    expect(outcome.type).toBe('skip');
    expect(outcome.sub).toContain('threshold');
  });

  it('renders the threshold ledger row SKIP and stops downstream rows', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: [threshold] }));
    const ledger = buildLedger(map.get('u1')!);
    const row = ledger.find((r) => r.id === 'threshold')!;
    expect(row.status).toBe('skip');
    expect(ledger.find((r) => r.id === 'reveal')!.status).toBe('notreached');
  });
});

describe('skill route decision surfaces in the ledger (U4/KTD6)', () => {
  it('renders the router-chose-RAG decision with the classifier intent', () => {
    const skill: StageRecord = {
      stage: 'skill',
      status: 'ran',
      latencyMs: 4,
      decision: 'none',
      reason: 'not_tool_intent',
      data: { intent: 'rag' },
    };
    const map = indexTrace(new Map(), traceEvent({ stages: [skill] }));
    const ledger = buildLedger(map.get('u1')!);
    const row = ledger.find((r) => r.id === 'skill')!;
    const flat = Object.fromEntries(row.detail);
    expect(flat['decision']).toBe('none');
    expect(flat['reason']).toBe('not_tool_intent');
    expect(flat['intent']).toBe('rag');
  });

  it('surfaces the chosen skill + args when a tool was kept', () => {
    const skill: StageRecord = {
      stage: 'skill',
      status: 'ran',
      latencyMs: 9,
      decision: 'kept',
      reason: 'github_count → source[0]',
      data: { intent: 'tool', skillName: 'github_count', args: { state: 'open' } },
    };
    const rows = Object.fromEntries(stageDetailRows(skill));
    expect(rows['skillName']).toBe('github_count');
    expect(rows['args']).toContain('open');
  });
});

describe('question-lane ledger (timing-visibility regression)', () => {
  // The question lane BYPASSES the relevance gate (heuristic short_circuited
  // with decision 'bypassed') and the run CONTINUES. The ledger used to treat
  // that as a terminal skip and mark every later stage "notreached", hiding all
  // recorded timings for question-lane utterances.
  const questionLaneStages: StageRecord[] = [
    { stage: 'empty-query', status: 'ran', latencyMs: 0, atMs: 0, decision: 'pass' },
    { stage: 'heuristic-gate', status: 'short_circuited', latencyMs: 0, atMs: 0, decision: 'bypassed', reason: 'question_lane' },
    { stage: 'llm-judge', status: 'skipped', latencyMs: 0, atMs: 0, reason: 'not_routed' },
    { stage: 'router', status: 'ran', latencyMs: 0, atMs: 0, decision: 'not_fired' },
    { stage: 'embed', status: 'ran', latencyMs: 250, atMs: 0, decision: 'embedded' },
    { stage: 'hybrid-search', status: 'ran', latencyMs: 1851, atMs: 250, data: { hits: [], count: 4, rpcMs: 400, rerankMs: 1400 } },
    { stage: 'emit', status: 'ran', latencyMs: 176, atMs: 2280, decision: 'emitted', data: { emitted: 4, cards: 4 } },
    { stage: 'synthesis', status: 'ran', latencyMs: 8000, atMs: 2460, decision: 'generated', data: { streamed: true, ttftMs: 900, firstProseMs: 1400 } },
    { stage: 'refusal-gate', status: 'ran', latencyMs: 1, atMs: 10460, decision: 'pass' },
    { stage: 'citation-verify', status: 'ran', latencyMs: 2, atMs: 10461, decision: 'grounded' },
    { stage: 'reveal', status: 'ran', latencyMs: 3, atMs: 10463, decision: 'revealed', data: { citations: 3 } },
  ];

  it('the heuristic BYPASS is informational, not a stop — later stages stay visible', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: questionLaneStages }));
    const ledger = buildLedger(map.get('u1')!);
    const embed = ledger.find((r) => r.id === 'embed')!;
    const search = ledger.find((r) => r.id === 'hybrid-search')!;
    const synth = ledger.find((r) => r.id === 'synthesis')!;
    expect(embed.status).not.toBe('notreached');
    expect(search.status).not.toBe('notreached');
    expect(synth.status).not.toBe('notreached');
    expect(search.latencyMs).toBe(1851);
  });

  it('ledger rows carry the stage start offset (atMs) for timeline rendering', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: questionLaneStages }));
    const ledger = buildLedger(map.get('u1')!);
    expect(ledger.find((r) => r.id === 'hybrid-search')!.atMs).toBe(250);
    expect(ledger.find((r) => r.id === 'synthesis')!.atMs).toBe(2460);
  });

  it('outcome ms is true wall-clock (max end offset), not the sum of latencies', () => {
    const map = indexTrace(new Map(), traceEvent({ stages: questionLaneStages }));
    const outcome = deriveOutcome(map.get('u1')!);
    // max(atMs + latency) = reveal at 10463+3 = 10466 — NOT the ~10.3s+ sum that
    // double-counts parallel/overlapping stages.
    expect(outcome.ms).toBe(10466);
    expect(outcome.type).toBe('grounded');
  });

  it('falls back to the latency sum for old traces without atMs', () => {
    const old: StageRecord[] = [
      { stage: 'embed', status: 'ran', latencyMs: 100 },
      { stage: 'hybrid-search', status: 'ran', latencyMs: 200, data: { hits: [], count: 1 } },
    ];
    const map = indexTrace(new Map(), traceEvent({ stages: old }));
    expect(deriveOutcome(map.get('u1')!).ms).toBe(300);
  });
});
