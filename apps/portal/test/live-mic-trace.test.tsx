import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('TracePanel', () => {
  it('renders the empty state when the selected utterance has no trace', () => {
    render(<TracePanel trace={null} cards={[]} utteranceText={null} />);
    expect(screen.getByText(/click a final transcript line/i)).toBeInTheDocument();
  });

  it('renders a gated utterance with the skip stage, its reason, and a short-circuit badge', () => {
    const trace: UtteranceTrace = {
      traceId: 'tr_u1',
      utteranceId: 'u1',
      meetingId: 'm1',
      stages: [
        {
          stage: 'heuristic-gate',
          status: 'short_circuited',
          decision: 'skip',
          reason: 'clearly_filler',
          latencyMs: 1,
        },
      ],
    };
    render(<TracePanel trace={trace} cards={[]} utteranceText="uh, yeah" />);
    expect(screen.getByText('Heuristic gate')).toBeInTheDocument();
    expect(screen.getByText('short-circuit')).toBeInTheDocument();
    expect(screen.getByText('clearly_filler')).toBeInTheDocument();
  });

  it('renders hybrid-search cards from the stage data.hits (self-contained trace)', () => {
    const trace: UtteranceTrace = {
      traceId: 'tr_u3',
      utteranceId: 'u3',
      meetingId: 'm1',
      stages: [
        {
          stage: 'hybrid-search',
          status: 'ran',
          latencyMs: 8,
          data: {
            count: 2,
            hits: [
              { rank: 1, title: 'Launch Plan', score: 0.9, distance: 0.12, ftsMatched: true, isSummary: true },
              { rank: 2, title: 'Spec Doc', score: 0.7, distance: null, ftsMatched: false, isSummary: false },
            ],
          },
        },
      ],
    };
    // Pass NO `cards` prop content — the panel must render purely from data.hits.
    render(<TracePanel trace={trace} cards={[]} utteranceText="what's the launch date?" />);
    expect(screen.getByText('Launch Plan')).toBeInTheDocument();
    expect(screen.getByText('Spec Doc')).toBeInTheDocument();
    expect(screen.getByText('2 hit(s)')).toBeInTheDocument();
    expect(screen.getByText('summary')).toBeInTheDocument(); // isSummary badge
    expect(screen.getByText(/dist 0\.120/)).toBeInTheDocument(); // vector hit
    expect(screen.getByText(/rrf 0\.7000/)).toBeInTheDocument(); // fts-only hit
  });

  it('falls back to the `cards` prop when an older trace carried only a count', () => {
    const trace: UtteranceTrace = {
      traceId: 'tr_u4',
      utteranceId: 'u4',
      meetingId: 'm1',
      // `hits` is a NUMBER (the pre-enrichment shape), not an array.
      stages: [{ stage: 'hybrid-search', status: 'ran', latencyMs: 8, data: { hits: 1 } }],
    };
    render(
      <TracePanel
        trace={trace}
        cards={[{ rank: 1, title: 'Legacy Card', source: 'github', docType: 'doc', distance: 0.2 }]}
        utteranceText="legacy"
      />,
    );
    expect(screen.getByText('Legacy Card')).toBeInTheDocument();
    expect(screen.getByText('1 hit(s)')).toBeInTheDocument();
  });

  it('renders the synthesis STATUS + citation count for an answered utterance', () => {
    const trace: UtteranceTrace = {
      traceId: 'tr_u2',
      utteranceId: 'u2',
      meetingId: 'm1',
      stages: [
        { stage: 'synthesis', status: 'ran', decision: 'answer', latencyMs: 10, data: { citations: 2 } },
        {
          stage: 'citation-verify',
          status: 'ran',
          latencyMs: 5,
          data: { total: 3, surviving: 2, dropped: 1, downgraded: 0 },
        },
      ],
    };
    render(<TracePanel trace={trace} cards={[]} utteranceText="what's the launch date?" />);
    expect(screen.getByText('answer')).toBeInTheDocument();
    expect(screen.getByText('1 dropped')).toBeInTheDocument();
  });
});
