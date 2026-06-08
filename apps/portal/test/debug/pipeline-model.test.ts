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
