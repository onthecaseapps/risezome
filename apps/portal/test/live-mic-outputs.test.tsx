import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OutputsPanel, type OutputCard, type OutputTab } from '../app/(authed)/debug/live-mic/_outputs-panel';
import type { UtteranceTrace } from '../app/(authed)/debug/live-mic/_pipeline-model';

const CARDS: OutputCard[] = [
  {
    cardId: 'c1',
    rank: 1,
    title: 'docs/plans/skill-routing.md',
    source: 'github',
    docType: 'file',
    snippet: 'The classifier routes utterances to GitHub skills.',
    body: 'x'.repeat(9998),
    distance: 0.341,
    score: 0.0164,
    ftsMatched: true,
    isSummary: false,
  },
  {
    cardId: 'c2',
    rank: 2,
    title: 'docs/plans/rolling-summary.md',
    source: 'github',
    docType: 'file',
    snippet: 'A rolling summarizer regenerates a structured meeting summary.',
    body: 'y'.repeat(7350),
    score: 0.0161,
    ftsMatched: false,
  },
];

const TRACE: UtteranceTrace = {
  traceId: 'tr1',
  utteranceId: 'u1',
  meetingId: 'm1',
  stages: [
    { stage: 'embed', status: 'ran', latencyMs: 38, data: { dims: 1024 } },
    { stage: 'reveal', status: 'ran', decision: 'revealed', latencyMs: 12 },
  ],
};

function renderPanel(over: Partial<Parameters<typeof OutputsPanel>[0]> = {}) {
  const onTab = vi.fn();
  const props = {
    tab: 'retrievals' as OutputTab,
    onTab,
    cards: CARDS,
    synthesis: <div>SYNTH_SLOT</div>,
    synthesisCount: 1,
    trace: TRACE,
    outcomeType: 'grounded' as const,
    ...over,
  };
  render(<OutputsPanel {...props} />);
  return { onTab };
}

describe('OutputsPanel', () => {
  it('renders the Retrievals tab with rank, distance, RRF, body size, and TOP MATCH', () => {
    renderPanel();
    expect(screen.getByText('2 hits')).toBeInTheDocument();
    expect(screen.getByText('TOP MATCH')).toBeInTheDocument();
    expect(screen.getByText('0.341')).toBeInTheDocument(); // distance
    expect(screen.getByText('0.0164')).toBeInTheDocument(); // RRF
    expect(screen.getByText('9,998 ch')).toBeInTheDocument(); // body size
  });

  it('switches tabs via onTab', () => {
    const { onTab } = renderPanel();
    fireEvent.click(screen.getByText('Trace JSON'));
    expect(onTab).toHaveBeenCalledWith('json');
    fireEvent.click(screen.getByText('Synthesis'));
    expect(onTab).toHaveBeenCalledWith('synthesis');
  });

  it('renders the synthesis slot on the Synthesis tab (reuses the real renderer)', () => {
    renderPanel({ tab: 'synthesis' });
    expect(screen.getByText('SYNTH_SLOT')).toBeInTheDocument();
  });

  it('pretty-prints the trace stages on the Trace JSON tab', () => {
    renderPanel({ tab: 'json' });
    expect(screen.getByText(/"traceId": "tr1"/)).toBeInTheDocument();
    expect(screen.getByText(/"stage": "reveal"/)).toBeInTheDocument();
  });

  it('Retrievals empty state differs for a skip (gated) vs a miss (no hits)', () => {
    renderPanel({ cards: [], outcomeType: 'skip' });
    expect(screen.getByText(/gated before embed/i)).toBeInTheDocument();
  });

  it('Retrievals empty state for a miss says no hits survived the floor', () => {
    renderPanel({ cards: [], outcomeType: 'miss' });
    expect(screen.getByText(/no hits survived the relevance floor/i)).toBeInTheDocument();
  });
});
