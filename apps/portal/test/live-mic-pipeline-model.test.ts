// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  STAGE_CATALOG,
  buildLedger,
  reachedCount,
  deriveOutcome,
  gateRibbon,
  waterfallSegments,
  stageDetailRows,
  indexTrace,
  type StageRecord,
  type UtteranceTrace,
  type TraceEvent,
} from '../app/(authed)/debug/live-mic/_pipeline-model';

function rec(stage: StageRecord['stage'], over: Partial<StageRecord> = {}): StageRecord {
  return { stage, status: 'ran', latencyMs: 5, ...over };
}

function trace(stages: StageRecord[]): UtteranceTrace {
  return { traceId: 't1', utteranceId: 'u1', meetingId: 'm1', stages };
}

const GROUNDED = trace([
  rec('empty-query', { decision: 'pass' }),
  rec('heuristic-gate', { decision: 'clearly_substantive' }),
  rec('router', { decision: 'not_fired', reason: 'not_tool_shaped' }),
  rec('embed', { latencyMs: 38, data: { dims: 1024 } }),
  rec('hybrid-search', { latencyMs: 52, data: { hits: [{ rank: 1 }, { rank: 2 }], count: 2 } }),
  rec('crag', { status: 'skipped', reason: 'confident', latencyMs: 0 }),
  rec('no-hits', { decision: 'pass', data: { hits: 2 } }),
  rec('dedup-expand', { data: { surviving: 2, parentDoc: false } }),
  rec('emit', { decision: 'emitted', data: { emitted: 2, cards: 2 } }),
  rec('skill', { decision: 'none', reason: 'router_not_fired' }),
  rec('synthesis', { decision: 'generated', latencyMs: 384, data: { chars: 142 } }),
  rec('refusal-gate', { decision: 'pass' }),
  rec('citation-verify', { decision: 'pass', latencyMs: 46, data: { total: 3, surviving: 3, dropped: 0, downgraded: 0 } }),
  rec('reveal', { decision: 'revealed', data: { citations: 3, encrypted: true } }),
]);

describe('STAGE_CATALOG', () => {
  it('is the canonical 16-row ledger with PRE + S04..S17 codes in order', () => {
    expect(STAGE_CATALOG).toHaveLength(16);
    expect(STAGE_CATALOG.map((r) => r.code)).toEqual([
      'PRE', 'PRE', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17',
    ]);
    // threshold + cooldown are portal-derived.
    expect(STAGE_CATALOG[0]!.derived).toBe(true);
    expect(STAGE_CATALOG[1]!.derived).toBe(true);
    // relevance merges the two real stages (KTD3).
    expect(STAGE_CATALOG.find((r) => r.id === 'relevance')!.mergeFrom).toEqual(['heuristic-gate', 'llm-judge']);
  });
});

describe('deriveOutcome', () => {
  it('grounded when reveal ran', () => {
    expect(deriveOutcome(GROUNDED).type).toBe('grounded');
  });

  it('miss when no-hits short-circuited (→ gap)', () => {
    const t = trace([rec('no-hits', { status: 'short_circuited', decision: 'miss', data: { recordedGap: true } })]);
    const o = deriveOutcome(t);
    expect(o.type).toBe('miss');
    expect(o.gap).toBe(true);
  });

  it('skip when heuristic short-circuited (filler)', () => {
    const t = trace([rec('heuristic-gate', { status: 'short_circuited', reason: 'clearly_filler' })]);
    expect(deriveOutcome(t).type).toBe('skip');
  });

  it('skip when llm-judge short-circuited', () => {
    const t = trace([
      rec('heuristic-gate', { decision: 'ambiguous' }),
      rec('llm-judge', { status: 'short_circuited', decision: 'skip', data: { confidence: 0.78 } }),
    ]);
    expect(deriveOutcome(t).type).toBe('skip');
  });

  it('ungrounded when citation-verify decision is ungrounded', () => {
    const t = trace([
      rec('synthesis', { decision: 'generated' }),
      rec('refusal-gate', { decision: 'pass' }),
      rec('citation-verify', { decision: 'ungrounded', data: { total: 2, surviving: 0 } }),
    ]);
    expect(deriveOutcome(t).type).toBe('ungrounded');
  });

  it('refusal when refusal-gate short-circuited', () => {
    const t = trace([
      rec('synthesis', { decision: 'generated' }),
      rec('refusal-gate', { status: 'short_circuited', decision: 'refusal' }),
    ]);
    expect(deriveOutcome(t).type).toBe('refusal');
  });

  it('ms is the sum of stage latencies', () => {
    expect(deriveOutcome(GROUNDED).ms).toBe(GROUNDED.stages.reduce((a, s) => a + s.latencyMs, 0));
  });
});

describe('buildLedger', () => {
  it('a grounded trace reaches 16/16', () => {
    const ledger = buildLedger(GROUNDED);
    expect(ledger).toHaveLength(16);
    expect(reachedCount(ledger)).toBe(16);
  });

  it('merges heuristic + judge into one Relevance row', () => {
    const ledger = buildLedger(GROUNDED);
    const rel = ledger.find((r) => r.id === 'relevance')!;
    expect(rel.status).toBe('pass');
    // its detail carries the heuristic sub-decision
    expect(rel.detail.some(([, v]) => v === 'clearly_substantive')).toBe(true);
  });

  it('marks every row past a terminal stop as not reached', () => {
    const t = trace([
      rec('empty-query', { decision: 'pass' }),
      rec('heuristic-gate', { decision: 'ambiguous' }),
      rec('llm-judge', { status: 'short_circuited', decision: 'skip', data: { confidence: 0.8 } }),
    ]);
    const ledger = buildLedger(t);
    const rel = ledger.find((r) => r.id === 'relevance')!;
    expect(rel.status).toBe('skip');
    // everything after relevance is not reached
    const idxRel = ledger.findIndex((r) => r.id === 'relevance');
    for (const row of ledger.slice(idxRel + 1)) expect(row.status).toBe('notreached');
  });

  it('threshold + cooldown render as informational "not gated in dev" rows (R9)', () => {
    const ledger = buildLedger(GROUNDED);
    for (const id of ['threshold', 'cooldown'] as const) {
      const row = ledger.find((r) => r.id === id)!;
      expect(row.status).toBe('info');
      expect(row.result).toMatch(/not gated in dev/i);
    }
  });

  it('CRAG that fired on a miss reads as fail-open, not pass', () => {
    const t = trace([
      rec('hybrid-search', { status: 'ran', data: { hits: [], count: 0 } }),
      rec('crag', { status: 'ran', decision: 'kept_original', reason: 'miss', latencyMs: 318 }),
      rec('no-hits', { status: 'short_circuited', decision: 'miss', data: { recordedGap: true } }),
    ]);
    const ledger = buildLedger(t);
    expect(ledger.find((r) => r.id === 'crag')!.status).toBe('failopen');
  });
});

describe('gateRibbon', () => {
  it('colors the dying segment for a judge skip', () => {
    const t = trace([
      rec('empty-query', { decision: 'pass' }),
      rec('heuristic-gate', { decision: 'ambiguous' }),
      rec('llm-judge', { status: 'short_circuited', decision: 'skip', data: { confidence: 0.8 } }),
    ]);
    const ribbon = gateRibbon(buildLedger(t));
    expect(ribbon.find((s) => s.id === 'relevance')!.status).toBe('skip');
    // downstream ribbon segments are not reached
    expect(ribbon.find((s) => s.id === 'no-hits')!.status).toBe('notreached');
  });
});

describe('waterfallSegments', () => {
  it('produces proportional widths summing to ~100% and labels only non-trivial stages', () => {
    const segs = waterfallSegments(buildLedger(GROUNDED));
    const total = segs.reduce((a, s) => a + s.pct, 0);
    expect(total).toBeCloseTo(100, 1);
    // embed (38ms) labeled; a 5ms stage is not.
    expect(segs.find((s) => s.id === 'embed')!.labeled).toBe(true);
    expect(segs.every((s) => s.ms > 0)).toBe(true);
  });
});

describe('stageDetailRows', () => {
  it('transforms hybrid-search hits into a readable count + flattens citation breakdown', () => {
    const hs = stageDetailRows(rec('hybrid-search', { data: { hits: [{ rank: 1 }, { rank: 2 }], count: 2 } }));
    expect(hs).toContainEqual(['hits', '2 ranked']);
    const cv = stageDetailRows(rec('citation-verify', { decision: 'pass', data: { total: 3, surviving: 3, dropped: 0, downgraded: 0 } }));
    expect(cv).toContainEqual(['decision', 'pass']);
    expect(cv).toContainEqual(['surviving', '3']);
  });
});

describe('indexTrace (re-homed in the model)', () => {
  it('stores by utteranceId and the latest run wins', () => {
    const e1: TraceEvent = { type: 'trace', traceId: 't1', utteranceId: 'u1', meetingId: 'm', stages: [rec('embed')] };
    const e2: TraceEvent = { type: 'trace', traceId: 't2', utteranceId: 'u1', meetingId: 'm', stages: [rec('embed'), rec('reveal')] };
    const m = indexTrace(indexTrace(new Map(), e1), e2);
    expect(m.get('u1')!.traceId).toBe('t2');
    expect(m.get('u1')!.stages).toHaveLength(2);
  });
});
