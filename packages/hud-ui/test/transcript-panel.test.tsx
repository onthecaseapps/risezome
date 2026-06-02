import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TranscriptPanel } from '../src/components/transcript-panel.js';
import type { TranscriptUtterance } from '../src/types.js';

function u(over: Partial<TranscriptUtterance> = {}): TranscriptUtterance {
  return {
    utteranceId: 'p1::1000',
    text: 'hello',
    speaker: 'Alice',
    isFinal: true,
    startMs: 1000,
    revision: 0,
    ...over,
  };
}

describe('TranscriptPanel (U4)', () => {
  it('groups consecutive utterances from the same speaker under one heading', () => {
    const { container } = render(
      <TranscriptPanel
        utterances={[
          u({ utteranceId: 'a', speaker: 'Alice', text: 'one', startMs: 1 }),
          u({ utteranceId: 'b', speaker: 'Alice', text: 'two', startMs: 2 }),
          u({ utteranceId: 'c', speaker: 'Bob', text: 'three', startMs: 3 }),
        ]}
      />,
    );
    const groups = container.querySelectorAll('.transcript-group');
    expect(groups).toHaveLength(2); // Alice (two lines) then Bob
    const speakers = Array.from(container.querySelectorAll('.transcript-speaker')).map((e) => e.textContent);
    expect(speakers).toEqual(['Alice', 'Bob']);
  });

  it('sorts by startMs regardless of input order', () => {
    const { container } = render(
      <TranscriptPanel
        utterances={[
          u({ utteranceId: 'b', speaker: 'Bob', text: 'second', startMs: 2000 }),
          u({ utteranceId: 'a', speaker: 'Alice', text: 'first', startMs: 1000 }),
        ]}
      />,
    );
    const speakers = Array.from(container.querySelectorAll('.transcript-speaker')).map((e) => e.textContent);
    expect(speakers).toEqual(['Alice', 'Bob']);
  });

  it('renders a partial with the partial affordance; a final has none', () => {
    const { container } = render(
      <TranscriptPanel
        utterances={[
          u({ utteranceId: 'a', text: 'settled', isFinal: true, startMs: 1 }),
          u({ utteranceId: 'b', text: 'in flight', isFinal: false, startMs: 2 }),
        ]}
      />,
    );
    const lines = container.querySelectorAll('.transcript-line');
    expect(lines).toHaveLength(2);
    expect(container.querySelectorAll('.transcript-line.is-partial')).toHaveLength(1);
    expect(container.querySelector('.transcript-cursor')).not.toBeNull();
  });

  it('renders an idle empty state when there are no utterances', () => {
    const { container, getByText } = render(<TranscriptPanel utterances={[]} />);
    expect(container.querySelector('.transcript-empty')).not.toBeNull();
    expect(getByText(/waiting for the conversation/i)).toBeTruthy();
  });

  it('renders a null speaker under an Unknown group', () => {
    const { getByText } = render(<TranscriptPanel utterances={[u({ speaker: null })]} />);
    expect(getByText('Unknown speaker')).toBeTruthy();
  });

  it('injects a per-utterance marker when provided', () => {
    const { container } = render(
      <TranscriptPanel
        utterances={[u({ utteranceId: 'anchored', text: 'asked a question', startMs: 1 })]}
        marker={(id) => (id === 'anchored' ? <button type="button" data-testid="anchor">●</button> : null)}
      />,
    );
    expect(container.querySelector('[data-testid="anchor"]')).not.toBeNull();
  });
});
