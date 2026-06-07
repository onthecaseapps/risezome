import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TranscriptUtterance } from '@risezome/hud-ui';
import {
  ReviewClient,
  nearestUtteranceIndex,
  type ReviewClientProps,
} from '../app/(authed)/meetings/[meetingId]/review/_client';
import type { StructuredRecap } from '../src/inngest/lib/meeting-recap';
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
    meetingId: 'm-1',
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

  it('wires synthesis pin actions so the surfaced answer shows a pin button', () => {
    // Regression: the review page previously rendered SynthesisStreamItem with no
    // SynthesisActionsProvider, so PinButton returned null (no pin on review).
    const { container } = renderReview({ anchorMap: { q1: 's1' } });
    const pin = container.querySelector('.pin-button');
    expect(pin).not.toBeNull();
    expect(pin?.getAttribute('aria-label')).toBe('Pin synthesis');
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
    meetingId: 'm-1',
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

const STRUCTURED: StructuredRecap = {
  overview: 'We chose the AI stack and the recap schema.',
  topics: [
    { text: 'AI models', timestampMs: 72_000 },
    { text: 'Embeddings provider', timestampMs: 220_000 },
  ],
  decisions: [{ category: 'Schema', text: 'Store recaps as structured JSON.' }],
  action_items: [{ text: 'Wire the regenerate button', assignee: 'Jason', timestampMs: 300_000 }],
  participants: [{ name: 'Alice' }, { name: 'Bob' }],
  speakerCount: 2,
};

describe('ReviewClient structured recap (U4)', () => {
  it('renders stat counts, topics with timestamps, categorized decisions, action items, and participants', () => {
    renderReview({ structuredRecap: STRUCTURED });

    expect(screen.getByText('We chose the AI stack and the recap schema.')).toBeInTheDocument();
    // Stat cards.
    expect(screen.getByTestId('stat-topics')).toHaveTextContent('2');
    expect(screen.getByTestId('stat-decisions')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-actions')).toHaveTextContent('1');
    expect(screen.getByTestId('stat-attendees')).toHaveTextContent('2');
    // Topics + timestamp chips.
    expect(screen.getByText('AI models')).toBeInTheDocument();
    expect(screen.getByText('01:12')).toBeInTheDocument();
    expect(screen.getByText('03:40')).toBeInTheDocument();
    // Decision category + text.
    expect(screen.getByText('Schema')).toBeInTheDocument();
    expect(screen.getByText('Store recaps as structured JSON.')).toBeInTheDocument();
    // Action item + assignee + timestamp.
    expect(screen.getByText('Wire the regenerate button')).toBeInTheDocument();
    expect(screen.getByText('Jason')).toBeInTheDocument();
    expect(screen.getByText('05:00')).toBeInTheDocument();
    // Participants rail (scoped — speaker names also appear in the transcript panel).
    expect(screen.getByText('Participants')).toBeInTheDocument();
    const rail = within(screen.getByTestId('participant-list'));
    expect(rail.getByText('Alice')).toBeInTheDocument();
    expect(rail.getByText('Bob')).toBeInTheDocument();
  });

  it('collapses the participants rail and shows 0 attendees for local-audio (empty participants)', () => {
    renderReview({
      structuredRecap: { ...STRUCTURED, participants: [], speakerCount: 0 },
    });
    expect(screen.getByTestId('stat-attendees')).toHaveTextContent('0');
    expect(screen.queryByText('Participants')).not.toBeInTheDocument();
    // The rest of the recap still renders.
    expect(screen.getByText('AI models')).toBeInTheDocument();
  });

  it('falls back to the markdown recap when no structured recap is present (old meetings)', () => {
    renderReview({
      structuredRecap: null,
      recapText: '## Overview\nWe talked about AI.\n\n## Action items\n- Ship the recap',
      recapStatus: 'done',
    });
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('We talked about AI.')).toBeInTheDocument();
    // No structured stat cards in the fallback path.
    expect(screen.queryByTestId('stat-topics')).not.toBeInTheDocument();
  });

  it('degrades to the empty state when both structured and markdown recaps are absent', () => {
    renderReview({ structuredRecap: null, recapText: null, recapStatus: 'done' });
    expect(screen.getByText(/no recap available/i)).toBeInTheDocument();
  });

  it('prefers the generating/failed status over a stale structured recap', () => {
    const { rerender } = renderReview({ structuredRecap: STRUCTURED, recapStatus: 'generating' });
    expect(screen.getByText(/generating the meeting recap/i)).toBeInTheDocument();
    rerender(
      <ReviewClient {...{ ...defaultProps(), structuredRecap: STRUCTURED, recapStatus: 'failed' }} />,
    );
    expect(screen.getByText(/could not be generated/i)).toBeInTheDocument();
  });
});

describe('ReviewClient Regenerate control (U6)', () => {
  it('calls the regenerate action with the meetingId on click', async () => {
    const user = userEvent.setup();
    const onRegenerate = vi.fn(async () => ({ ok: true as const }));
    renderReview({ meetingId: 'm-42', structuredRecap: STRUCTURED, onRegenerate });
    await user.click(screen.getByRole('button', { name: /regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledWith('m-42');
  });

  it('disables the control while the recap is generating', () => {
    const onRegenerate = vi.fn(async () => ({ ok: true as const }));
    renderReview({ structuredRecap: STRUCTURED, recapStatus: 'generating', onRegenerate });
    expect(screen.getByRole('button', { name: /regenerating/i })).toBeDisabled();
  });

  it('omits the control when no action is provided', () => {
    renderReview({ structuredRecap: STRUCTURED });
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
  });
});

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

describe('nearestUtteranceIndex', () => {
  it('returns -1 for an empty transcript', () => {
    expect(nearestUtteranceIndex([], 100)).toBe(-1);
  });

  it('falls back to the first utterance when the moment precedes all of them', () => {
    expect(nearestUtteranceIndex([100, 200], 50)).toBe(0);
  });

  it('returns the last utterance at or before the moment (inclusive)', () => {
    expect(nearestUtteranceIndex([0, 100, 200, 300], 250)).toBe(2);
    expect(nearestUtteranceIndex([0, 100, 200], 200)).toBe(2);
    expect(nearestUtteranceIndex([0, 100, 200], 99999)).toBe(2);
  });
});

describe('ReviewClient — jump-to-moment timestamps', () => {
  // Transcript startMs is ABSOLUTE epoch ms; recap timestampMs is relative
  // elapsed-from-first-utterance. The base below is an arbitrary epoch; the three
  // utterances sit at +0s, +60s, +180s.
  const BASE = 1_780_000_000_000;
  const ABS_TRANSCRIPT: TranscriptUtterance[] = [
    { utteranceId: 'a', text: 'opening remarks', speaker: 'Alice', isFinal: true, startMs: BASE, endMs: BASE + 1000, revision: 0 },
    { utteranceId: 'b', text: 'the middle bit', speaker: 'Bob', isFinal: true, startMs: BASE + 60_000, endMs: BASE + 61_000, revision: 0 },
    { utteranceId: 'c', text: 'the closing bit', speaker: 'Cara', isFinal: true, startMs: BASE + 180_000, endMs: BASE + 181_000, revision: 0 },
  ];
  // Topic at 02:50 (170_000ms relative) → nearest at/before is the +60s utterance.
  const RECAP: StructuredRecap = {
    ...STRUCTURED,
    topics: [{ text: 'A mid-meeting topic', timestampMs: 170_000 }],
  };

  it('normalizes absolute transcript startMs against the relative recap timestamp (not the first line)', async () => {
    const user = userEvent.setup();
    const originalScroll = Element.prototype.scrollIntoView;
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const { container } = renderReview({
        structuredRecap: RECAP,
        initialTranscript: ABS_TRANSCRIPT,
        anchorMap: {},
      });
      await user.click(screen.getByRole('button', { name: /jump to 02:50/i }));
      expect(scrollSpy).toHaveBeenCalled();
      // Lands on the +60s utterance, NOT the first (would be the bug).
      const target = container.querySelector(`[data-start-ms="${BASE + 60_000}"]`);
      expect(target).not.toBeNull();
      expect(target!.classList.contains('rz-ts-pulse')).toBe(true);
      // The first utterance must NOT be the pulsed one.
      const first = container.querySelector(`[data-start-ms="${BASE}"]`);
      expect(first!.classList.contains('rz-ts-pulse')).toBe(false);
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
    }
  });
});
