import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TranscriptUtterance } from '@risezome/hud-ui';
import { ReviewClient, type ReviewClientProps } from '../app/(authed)/meetings/[meetingId]/review/_client';
import {
  normalizeCitations,
  resolveSynthesisAnchors,
  type AnchorSynthesis,
  type InitialSynthesis,
  type UtteranceTime,
} from '../app/(authed)/meetings/[meetingId]/_synthesis-seed';

const TRANSCRIPT: TranscriptUtterance[] = [
  { utteranceId: 'q1', text: 'do we use AI', speaker: 'Alice', isFinal: true, startMs: 1, endMs: 2, revision: 0 },
  { utteranceId: 'chat', text: 'nice weather today', speaker: 'Bob', isFinal: true, startMs: 2, endMs: 3, revision: 0 },
];

const SYNTHESIS: InitialSynthesis = {
  synthesisId: 's1',
  sourceCardIds: [],
  accumulatedText: 'Yes, the project uses Claude.',
  status: 'done',
  traceId: 't1',
  citations: [],
  pinned: false,
  pinnedAt: null,
};

function renderReview(over: Partial<ReviewClientProps> = {}) {
  const props: ReviewClientProps = {
    title: 'Standup',
    status: 'completed',
    startedAtIso: null,
    endedAtIso: null,
    recapText: '## Overview\nWe talked about AI.\n\n## Action items\n- Ship the recap',
    recapStatus: 'done',
    initialTranscript: TRANSCRIPT,
    initialSyntheses: [SYNTHESIS],
    initialCards: [],
    anchorMap: { q1: 's1' },
    ...over,
  };
  return render(<ReviewClient {...props} />);
}

describe('ReviewClient (U8)', () => {
  it('renders the recap (markdown-lite) when done', () => {
    renderReview();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('We talked about AI.')).toBeInTheDocument();
    expect(screen.getByText('Ship the recap')).toBeInTheDocument();
  });

  it('shows a generating state and a failed state', () => {
    const { rerender } = renderReview({ recapText: null, recapStatus: 'generating' });
    expect(screen.getByText(/generating the meeting recap/i)).toBeInTheDocument();
    rerender(<ReviewClient {...{ ...defaultProps(), recapText: null, recapStatus: 'failed' }} />);
    expect(screen.getByText(/could not be generated/i)).toBeInTheDocument();
  });

  it('defaults to showing the first surfaced answer; the anchored utterance is clickable + active', async () => {
    const user = userEvent.setup();
    const { container } = renderReview({ anchorMap: { q1: 's1' } });
    expect(container.querySelectorAll('.transcript-anchor')).toHaveLength(1);
    // Defaults to the first summary card (no click needed) and marks its
    // anchored question active in the transcript.
    expect(screen.getByText(/uses Claude/i)).toBeInTheDocument();
    expect(container.querySelector('.transcript-anchor.is-active')).not.toBeNull();
    // The anchored utterance is still clickable; its card stays open.
    await user.click(screen.getByText(/do we use AI/i));
    expect(screen.getByText(/uses Claude/i)).toBeInTheDocument();
  });

  it('with no syntheses, shows the no-summaries hint and no anchors', () => {
    const { container } = renderReview({ initialSyntheses: [], anchorMap: {} });
    expect(container.querySelectorAll('.transcript-anchor')).toHaveLength(0);
    expect(screen.getByText(/no summaries were generated/i)).toBeInTheDocument();
  });

  it('handles a meeting with no transcript', () => {
    renderReview({ initialTranscript: [], anchorMap: {} });
    expect(screen.getByText(/no transcript was captured/i)).toBeInTheDocument();
  });
});

function defaultProps(): ReviewClientProps {
  return {
    title: 'Standup',
    status: 'completed',
    startedAtIso: null,
    endedAtIso: null,
    recapText: null,
    recapStatus: 'done',
    initialTranscript: TRANSCRIPT,
    initialSyntheses: [SYNTHESIS],
    initialCards: [],
    anchorMap: { q1: 's1' },
  };
}

describe('normalizeCitations (R8 — old rows render correctly)', () => {
  it('converts a legacy numeric-rank citations array to the object shape', () => {
    const out = normalizeCitations([1, 2], ['cardA', 'cardB'], 'answer [1] and [2] here');
    expect(out).toEqual([
      { rank: 1, cardId: 'cardA', position: expect.any(Number) },
      { rank: 2, cardId: 'cardB', position: expect.any(Number) },
    ]);
  });

  it('passes through the new object shape with quotes', () => {
    const out = normalizeCitations([{ rank: 1, cardId: 'c', position: 5, quote: 'q' }], ['c'], 'x');
    expect(out[0]).toMatchObject({ rank: 1, cardId: 'c', quote: 'q' });
  });

  it('drops out-of-range legacy ranks', () => {
    expect(normalizeCitations([3], ['only-one'], 'x')).toEqual([]);
  });
});

describe('resolveSynthesisAnchors', () => {
  const utterances: UtteranceTime[] = [
    { utteranceId: 'u-ai', tMs: 1000 },
    { utteranceId: 'u-github', tMs: 2000 },
    { utteranceId: 'u-plans', tMs: 3000 },
  ];

  it('uses the stored trigger utterance when present (U6)', () => {
    const syn: AnchorSynthesis[] = [{ synthesisId: 's1', triggerUtteranceId: 'u-plans', createdAtMs: 1500 }];
    expect(resolveSynthesisAnchors(syn, utterances)).toEqual({ 'u-plans': 's1' });
  });

  it('anchors a null-trigger synthesis to the utterance spoken just before it', () => {
    // Two syntheses fired right after two different questions → two distinct,
    // correct anchors (no collision onto a shared cited card).
    const syn: AnchorSynthesis[] = [
      { synthesisId: 's-ai', triggerUtteranceId: null, createdAtMs: 1100 },
      { synthesisId: 's-plans', triggerUtteranceId: null, createdAtMs: 3100 },
    ];
    expect(resolveSynthesisAnchors(syn, utterances)).toEqual({
      'u-ai': 's-ai',
      'u-plans': 's-plans',
    });
  });

  it('first synthesis (by created time) claims a shared utterance', () => {
    const syn: AnchorSynthesis[] = [
      { synthesisId: 'first', triggerUtteranceId: null, createdAtMs: 2200 },
      { synthesisId: 'second', triggerUtteranceId: null, createdAtMs: 2300 },
    ];
    // Both resolve to u-github (latest <= createdAt); earliest wins.
    expect(resolveSynthesisAnchors(syn, utterances)).toEqual({ 'u-github': 'first' });
  });

  it('drops a synthesis with no utterance before it and no trigger', () => {
    const syn: AnchorSynthesis[] = [{ synthesisId: 's', triggerUtteranceId: null, createdAtMs: 500 }];
    expect(resolveSynthesisAnchors(syn, utterances)).toEqual({});
  });
});
