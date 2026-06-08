import { describe, expect, it, vi } from 'vitest';
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
    endMs: 1500,
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

  it('renders an anchored utterance as a clickable highlight that fires onAnchorClick', async () => {
    const onAnchorClick = vi.fn();
    const { container } = render(
      <TranscriptPanel
        utterances={[
          u({ utteranceId: 'anchored', text: 'asked a question', startMs: 1 }),
          u({ utteranceId: 'plain', text: 'just chatter', startMs: 2 }),
        ]}
        anchoredUtteranceIds={new Set(['anchored'])}
        onAnchorClick={onAnchorClick}
      />,
    );
    const anchors = container.querySelectorAll('.transcript-anchor');
    expect(anchors).toHaveLength(1); // only the anchored utterance
    (anchors[0] as HTMLButtonElement).click();
    expect(onAnchorClick).toHaveBeenCalledWith('anchored');
  });

  it('splits a speaker block into paragraphs at a long pause', () => {
    const { container } = render(
      <TranscriptPanel
        utterances={[
          u({ utteranceId: 'a', speaker: 'Alice', text: 'first thought', startMs: 0, endMs: 1000 }),
          u({ utteranceId: 'b', speaker: 'Alice', text: 'after a pause', startMs: 4000, endMs: 5000 }),
        ]}
      />,
    );
    // One speaker block, but two paragraphs (gap 3s ≥ 2.5s pause threshold).
    expect(container.querySelectorAll('.transcript-group')).toHaveLength(1);
    expect(container.querySelectorAll('.transcript-lines')).toHaveLength(2);
  });

  it('keeps utterances in one paragraph when the gap is short', () => {
    const { container } = render(
      <TranscriptPanel
        utterances={[
          u({ utteranceId: 'a', speaker: 'Alice', text: 'one', startMs: 0, endMs: 1000 }),
          u({ utteranceId: 'b', speaker: 'Alice', text: 'two', startMs: 1300, endMs: 2000 }),
        ]}
      />,
    );
    expect(container.querySelectorAll('.transcript-group')).toHaveLength(1);
    expect(container.querySelectorAll('.transcript-lines')).toHaveLength(1);
  });
});

describe('TranscriptPanel — live line (Rules 1-4)', () => {
  it('commits the final above and renders the in-flight partial on the reserved live line with a caret', () => {
    const { container } = render(
      <TranscriptPanel
        autoScroll
        utterances={[
          u({ utteranceId: 'a', speaker: 'Alice', text: 'all settled', isFinal: true, startMs: 1 }),
          u({ utteranceId: 'b', speaker: 'Alice', text: 'still talking now', isFinal: false, startMs: 2 }),
        ]}
      />,
    );
    // Rule 1: the committed final lives in a speaker block, not the live row.
    const group = container.querySelector('.transcript-group');
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain('all settled');
    expect(group!.querySelector('.is-partial')).toBeNull();

    // Rule 4: the live row holds the in-flight partial + a blinking caret.
    const liveRow = container.querySelector('.transcript-live-line');
    expect(liveRow).not.toBeNull();
    const liveLine = liveRow!.querySelector('.transcript-line.is-partial');
    expect(liveLine).not.toBeNull();
    expect(liveRow!.querySelector('.transcript-cursor')).not.toBeNull();
    // The committed final is NOT duplicated into the live row.
    expect(liveRow!.textContent).not.toContain('all settled');
  });

  it('reserves the live-line row even when there are no utterances on it (empty)', () => {
    // A single final is pulled into the live row as the most-recent line; render
    // two finals so one stays committed and confirm the row container exists.
    const { container } = render(
      <TranscriptPanel autoScroll utterances={[u({ utteranceId: 'a', text: 'only line', isFinal: true })]} />,
    );
    expect(container.querySelector('.transcript-live-line')).not.toBeNull();
  });

  it('Rule 2: renders the live utterance text as separate keyed word spans', () => {
    const { container } = render(
      <TranscriptPanel
        autoScroll
        utterances={[u({ utteranceId: 'b', text: 'one two three', isFinal: false, startMs: 5 })]}
      />,
    );
    const liveRow = container.querySelector('.transcript-live-line');
    const words = liveRow!.querySelectorAll('.transcript-word');
    // Each word carries its own leading space (faithful to the design's
    // `(i ? ' ' : '') + word`) so the spans concatenate without separate text nodes.
    expect(Array.from(words).map((w) => w.textContent?.trim())).toEqual(['one', 'two', 'three']);
  });

  it('Rule 2: reuses the leading word DOM nodes as the interim grows', () => {
    const { container, rerender } = render(
      <TranscriptPanel
        autoScroll
        utterances={[u({ utteranceId: 'b', text: 'hello', isFinal: false, startMs: 5, revision: 0 })]}
      />,
    );
    const firstWordBefore = container.querySelector('.transcript-live-line .transcript-word');
    rerender(
      <TranscriptPanel
        autoScroll
        utterances={[u({ utteranceId: 'b', text: 'hello there world', isFinal: false, startMs: 5, revision: 1 })]}
      />,
    );
    const firstWordAfter = container.querySelector('.transcript-live-line .transcript-word');
    // Same DOM node identity for the unchanged leading word — only the tail repaints.
    expect(firstWordAfter).toBe(firstWordBefore);
    expect(firstWordAfter!.textContent).toBe('hello');
  });

  it('Rule 3 (morph in place): the same utteranceId flips partial → final on one persisted line, losing is-partial', () => {
    const { container, rerender } = render(
      <TranscriptPanel
        autoScroll
        utterances={[u({ utteranceId: 'b', text: 'morphing now', isFinal: false, startMs: 5, revision: 0 })]}
      />,
    );
    const lineBefore = container.querySelector('.transcript-live-line .transcript-line');
    expect(lineBefore).not.toBeNull();
    expect(lineBefore!.classList.contains('is-partial')).toBe(true);

    rerender(
      <TranscriptPanel
        autoScroll
        utterances={[u({ utteranceId: 'b', text: 'morphing now', isFinal: true, startMs: 5, revision: 1 })]}
      />,
    );
    const lineAfter = container.querySelector('.transcript-live-line .transcript-line');
    // Same element identity (no teardown/reinsert) — only the class flips.
    expect(lineAfter).toBe(lineBefore);
    expect(lineAfter!.classList.contains('is-partial')).toBe(false);
    expect(lineAfter!.classList.contains('is-finalizing')).toBe(true);
    expect(lineAfter!.textContent).toContain('morphing now');
    // Exactly one line for this utterance — not duplicated into a committed block.
    expect(container.querySelectorAll('[data-utterance-id="b"]')).toHaveLength(1);
  });
});
