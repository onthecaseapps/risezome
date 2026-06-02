import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HudCard } from '../app/components/demo/hud-card';
import { SynthesisCard } from '../app/components/demo/synthesis-card';
import { sourceChipClass, rankLabel } from '../app/components/demo/card-bits';
import type { DemoCard, DemoSynthesis } from '../app/components/demo/types';

const topCard: DemoCard = {
  id: 'c1',
  source: 'github',
  type: 'doc',
  title: 'docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md',
  docHeading: '## Phase 1.5 — Dogfood gate (no new units)',
  snippet: 'This phase ships no code. Its only output is a go/no-go decision.',
  rank: 1,
};

describe('HudCard', () => {
  it('renders a GitHub-accented top-match card with title, heading, snippet, and Pin', () => {
    render(<HudCard card={topCard} />);

    // Source chip carries the github accent class (the load-bearing color signal).
    const chip = screen.getByText('github');
    expect(chip).toHaveClass('chip-source', 'chip-source-github');

    // Top match label is accented.
    const score = screen.getByText('Top match');
    expect(score).toHaveClass('score', 'top');

    expect(screen.getByText(topCard.title)).toBeInTheDocument();
    expect(screen.getByText(topCard.docHeading!)).toBeInTheDocument();
    expect(screen.getByText(topCard.snippet)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pin/i })).toBeInTheDocument();
  });

  it('labels non-top cards as a plain "Match" without the accent', () => {
    render(<HudCard card={{ ...topCard, id: 'c2', rank: 3 }} />);
    const score = screen.getByText('Match');
    expect(score).toHaveClass('score');
    expect(score).not.toHaveClass('top');
  });

  it('adds the entering animation class only when entering', () => {
    const { container, rerender } = render(<HudCard card={topCard} />);
    expect(container.querySelector('.card')).not.toHaveClass('is-entering');
    rerender(<HudCard card={topCard} entering />);
    expect(container.querySelector('.card')).toHaveClass('is-entering');
  });
});

describe('source color + rank mapping', () => {
  it('maps each known source to its accent class and unknown to default', () => {
    expect(sourceChipClass('github')).toBe('chip-source chip-source-github');
    expect(sourceChipClass('jira')).toBe('chip-source chip-source-jira');
    expect(sourceChipClass('slack')).toBe('chip-source chip-source-slack');
    expect(sourceChipClass('code')).toBe('chip-source chip-source-code');
    // @ts-expect-error — exercising the runtime default fallback for an off-type source
    expect(sourceChipClass('unknown')).toBe('chip-source chip-source-default');
  });

  it('formats rank 1 as Top match, others as Match', () => {
    expect(rankLabel(1)).toBe('Top match');
    expect(rankLabel(2)).toBe('Match');
  });
});

const synthesis: DemoSynthesis = {
  text: "PR #482 is open and blocked on review [1]; the migration doc covers the rollout [2].",
  citations: [1, 2],
  sources: [
    { id: 's1', source: 'github', type: 'pull-request', title: 'Auth migration to OAuth2', rank: 1, snippet: '' },
    { id: 's2', source: 'jira', type: 'issue', title: 'AUTH-204', rank: 2, snippet: '' },
    { id: 's3', source: 'github', type: 'doc', title: 'docs/auth-migration.md', rank: 3, snippet: '' },
  ],
};

describe('SynthesisCard', () => {
  it('renders the AI Summary with inline citation chips and a Sources(n) list when done', () => {
    render(<SynthesisCard synthesis={synthesis} />);
    expect(screen.getByText(/Summary/i)).toBeInTheDocument();
    // Citations are inline chips in the answer text — no trailing citation row.
    expect(screen.getByText('[1]')).toHaveClass('cite-inline');
    expect(screen.getByText('[2]')).toHaveClass('cite-inline');
    expect(screen.getByText('Sources (3)')).toBeInTheDocument();
    expect(screen.getByText('Auth migration to OAuth2')).toBeInTheDocument();
  });

  it('streams inline citations but withholds the sources, and shows a cursor', () => {
    const { container } = render(<SynthesisCard synthesis={synthesis} streaming />);
    // Inline citations are part of the answer and stream with the text.
    expect(screen.getByText('[1]')).toHaveClass('cite-inline');
    // Sources stay hidden until the answer is done.
    expect(screen.queryByText(/^Sources/)).not.toBeInTheDocument();
    expect(container.querySelector('.synthesis-cursor')).toBeInTheDocument();
  });

  it('expands the clicked source: reveals its snippet with the cited quote highlighted and lights its inline chip', () => {
    const expandable: DemoSynthesis = {
      text: 'PR #482 swaps cookies for tokens [1].',
      citations: [1],
      sources: [
        {
          id: 's1',
          source: 'github',
          type: 'pull-request',
          title: 'Auth migration to OAuth2',
          rank: 1,
          snippet: 'Swaps cookies for tokens. 14 files changed.',
          quote: 'Swaps cookies for tokens',
        },
      ],
      expandedSourceId: 's1',
    };
    render(<SynthesisCard synthesis={expandable} />);

    // The cited quote is wrapped in a highlight mark.
    const mark = screen.getByText('Swaps cookies for tokens');
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveClass('hl');

    // The matching inline [1] chip lights up while its source is expanded.
    expect(screen.getByText('[1]')).toHaveClass('cite-inline', 'is-active');
  });

  it('keeps a source collapsed (snippet hidden) until it is the expanded one', () => {
    const collapsed: DemoSynthesis = {
      text: 'PR #482 [1].',
      citations: [1],
      sources: [
        {
          id: 's1',
          source: 'github',
          type: 'pull-request',
          title: 'Auth migration to OAuth2',
          rank: 1,
          snippet: 'Swaps cookies for tokens.',
          quote: 'Swaps cookies for tokens',
        },
      ],
      expandedSourceId: null,
    };
    render(<SynthesisCard synthesis={collapsed} />);
    expect(screen.getByText('Auth migration to OAuth2')).toBeInTheDocument();
    expect(screen.queryByText('Swaps cookies for tokens')).not.toBeInTheDocument();
    expect(screen.getByText('[1]')).not.toHaveClass('is-active');
  });
});
