import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuestionCard } from '../app/(authed)/debug/eval/_client';

type CardProps = Parameters<typeof QuestionCard>[0];
type RunState = CardProps['state'];

function completedView(over: Record<string, unknown> = {}): RunState {
  return {
    question: { q: 'what ai models do we use' },
    result: { pass: true, answerContainsAll: true },
    sources: [],
    rawSynthesis: 'STATUS: answer\nWe use Claude Haiku, Voyage, Deepgram.',
    answer: 'We use Claude Haiku, Voyage, Deepgram.',
    isRefusal: false,
    suppressed: false,
    refusalReason: null,
    citations: [],
    droppedQuoted: 0,
    downgradedToBare: 0,
    ragas: null,
    latencyMs: 120,
    gateSuppressed: false,
    ...over,
  } as unknown as RunState;
}

function renderCard(state: RunState): void {
  render(<QuestionCard question={{ q: 'what ai models do we use' }} state={state} onRun={vi.fn()} />);
}

describe('eval triggering verdict (U7)', () => {
  it('AE7: a question-lane verdict renders the fires badge + block', () => {
    renderCard(
      completedView({
        triggeringVerdict: { lane: 'question', isQuestion: true, wouldFire: true, reason: 'interrogative' },
      }),
    );
    expect(screen.getByText(/Q-lane · fires/i)).toBeTruthy();
    expect(screen.getByText(/fires immediately/i)).toBeTruthy();
  });

  it('AE7: an ambient (would-not-fire) verdict renders the no-fire badge + block', () => {
    renderCard(
      completedView({
        triggeringVerdict: { lane: 'ambient', isQuestion: false, wouldFire: false, reason: 'rhetorical' },
      }),
    );
    expect(screen.getByText(/ambient · no fire/i)).toBeTruthy();
    expect(screen.getByText(/would not fire as a question/i)).toBeTruthy();
  });

  it('back-compat: a response without a verdict renders without crashing and shows no verdict', () => {
    renderCard(completedView());
    expect(screen.queryByText(/fires immediately|would not fire as a question/i)).toBeNull();
    // The rest of the card still renders.
    expect(screen.getByText(/We use Claude Haiku/i)).toBeTruthy();
  });
});
