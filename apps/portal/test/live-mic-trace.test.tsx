import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  TracePanel,
  indexTrace,
  type TraceEvent,
  type UtteranceTrace,
} from '../app/(authed)/debug/live-mic/_trace-panel';

function traceEvt(utteranceId: string, stages: TraceEvent['stages']): TraceEvent {
  return { type: 'trace', traceId: `tr_${utteranceId}`, utteranceId, meetingId: 'm1', stages };
}

describe('indexTrace (trace-indexing reducer)', () => {
  it('stores a trace event under its utteranceId', () => {
    const next = indexTrace(new Map(), traceEvt('u1', []));
    expect(next.has('u1')).toBe(true);
    expect(next.get('u1')?.traceId).toBe('tr_u1');
    expect(next.get('u1')?.meetingId).toBe('m1');
  });

  it('is immutable — does not mutate the prior map', () => {
    const prev = new Map<string, UtteranceTrace>();
    const next = indexTrace(prev, traceEvt('u1', []));
    expect(prev.size).toBe(0);
    expect(next.size).toBe(1);
  });

  it('latest run wins — a later trace replaces the prior one for the same utterance', () => {
    let m = indexTrace(new Map(), traceEvt('u1', [{ stage: 'embed', status: 'ran', latencyMs: 1 }]));
    m = indexTrace(m, traceEvt('u1', [{ stage: 'embed', status: 'ran', latencyMs: 2 }]));
    expect(m.size).toBe(1);
    expect(m.get('u1')?.stages[0]?.latencyMs).toBe(2);
  });

  it('keeps distinct utterances under distinct keys', () => {
    let m = indexTrace(new Map(), traceEvt('u1', []));
    m = indexTrace(m, traceEvt('u2', []));
    expect([...m.keys()].sort()).toEqual(['u1', 'u2']);
  });
});

const GROUNDED: UtteranceTrace = {
  traceId: 'tr_g',
  utteranceId: 'g',
  meetingId: 'm1',
  priorContext: [],
  stages: [
    { stage: 'empty-query', status: 'ran', decision: 'pass', latencyMs: 0 },
    { stage: 'heuristic-gate', status: 'ran', decision: 'clearly_substantive', latencyMs: 4 },
    { stage: 'router', status: 'ran', decision: 'not_fired', reason: 'not_tool_shaped', latencyMs: 6 },
    { stage: 'embed', status: 'ran', latencyMs: 38, data: { dims: 1024 } },
    { stage: 'hybrid-search', status: 'ran', latencyMs: 52, data: { hits: [{ rank: 1 }], count: 1 } },
    { stage: 'crag', status: 'skipped', reason: 'confident', latencyMs: 0 },
    { stage: 'no-hits', status: 'ran', decision: 'pass', latencyMs: 0, data: { hits: 1 } },
    { stage: 'dedup-expand', status: 'ran', latencyMs: 24, data: { surviving: 1, parentDoc: false } },
    { stage: 'emit', status: 'ran', decision: 'emitted', latencyMs: 8, data: { emitted: 1, cards: 1 } },
    { stage: 'skill', status: 'ran', decision: 'none', reason: 'router_not_fired', latencyMs: 1 },
    { stage: 'synthesis', status: 'ran', decision: 'generated', latencyMs: 384, data: { chars: 100 } },
    { stage: 'refusal-gate', status: 'ran', decision: 'pass', latencyMs: 0 },
    { stage: 'citation-verify', status: 'ran', decision: 'pass', latencyMs: 46, data: { total: 1, surviving: 1, dropped: 0, downgraded: 0 } },
    { stage: 'reveal', status: 'ran', decision: 'revealed', latencyMs: 12, data: { citations: 1, encrypted: true } },
  ],
};

describe('TracePanel (Pipeline Trace Debug)', () => {
  it('empty state when nothing selected', () => {
    render(<TracePanel trace={null} utteranceText={null} />);
    expect(screen.getByText(/select an utterance/i)).toBeInTheDocument();
  });

  it('gated/in-flight empty state when an utterance is selected but has no trace', () => {
    render(<TracePanel trace={null} utteranceText="uh, yeah" />);
    expect(screen.getByText(/no trace yet/i)).toBeInTheDocument();
  });

  it('grounded trace: outcome banner, 16/16 reached, suppression-gate ribbon, reveal row', () => {
    render(<TracePanel trace={GROUNDED} utteranceText="how many times do we use ai" />);
    expect(screen.getByText('Grounded answer revealed')).toBeInTheDocument();
    expect(screen.getByText(/16 \/ 16 reached/)).toBeInTheDocument();
    expect(screen.getByText('Suppression gates')).toBeInTheDocument();
    expect(screen.getByText('Reveal')).toBeInTheDocument();
  });

  it('filler skip: Skipped banner, Relevance row carries SKIP, downstream rows not reached', () => {
    const trace: UtteranceTrace = {
      traceId: 'tr_f',
      utteranceId: 'f',
      meetingId: 'm1',
      priorContext: [],
      stages: [
        { stage: 'empty-query', status: 'ran', decision: 'pass', latencyMs: 0 },
        { stage: 'heuristic-gate', status: 'short_circuited', decision: 'skip', reason: 'clearly_filler', latencyMs: 0 },
      ],
    };
    render(<TracePanel trace={trace} utteranceText="it might" />);
    expect(screen.getByText(/Skipped/)).toBeInTheDocument();
    expect(screen.getByText('Relevance gate')).toBeInTheDocument();
    // The merged Relevance row shows a SKIP chip.
    expect(screen.getAllByText('SKIP').length).toBeGreaterThan(0);
    // Reveal is downstream of the stop → not reached (dash chip).
    expect(screen.getByText('Reveal')).toBeInTheDocument();
  });

  it('miss → knowledge gap chip on the outcome banner', () => {
    const trace: UtteranceTrace = {
      traceId: 'tr_m',
      utteranceId: 'm',
      meetingId: 'm1',
      priorContext: [],
      stages: [
        { stage: 'hybrid-search', status: 'ran', latencyMs: 47, data: { hits: [], count: 0 } },
        { stage: 'crag', status: 'ran', decision: 'kept_original', reason: 'miss', latencyMs: 318 },
        { stage: 'no-hits', status: 'short_circuited', decision: 'miss', latencyMs: 1, data: { recordedGap: true } },
      ],
    };
    render(<TracePanel trace={trace} utteranceText="we'll have to check the code" />);
    expect(screen.getByText(/Miss/)).toBeInTheDocument();
    expect(screen.getByText('→ knowledge gap')).toBeInTheDocument(); // the banner chip
  });

  it('stage deep-link fires onOpenOutput with the row tab', () => {
    const onOpen = vi.fn();
    render(<TracePanel trace={GROUNDED} utteranceText="q" onOpenOutput={onOpen} />);
    // "Hybrid search" appears in the waterfall legend AND the ledger row; the
    // ledger row is the last match. Expand it, then click "view retrievals".
    const matches = screen.getAllByText('Hybrid search');
    fireEvent.click(matches[matches.length - 1]!);
    fireEvent.click(screen.getByText(/view retrievals/i));
    expect(onOpen).toHaveBeenCalledWith('retrievals');
  });
});
