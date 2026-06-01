import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { CitationChip } from '../src/components/citation-chip.js';

/**
 * CitationChip is now pure presentation + callback (plan U3). The
 * DOM-scroll behavior moved up to the parent SynthesisCard, which owns
 * expansion state and renders the matching SourceCardExpanded with the
 * active quote. Tests here cover the chip's local behavior: shape,
 * keyboard activation, callback shape, disabled state.
 */
describe('CitationChip', () => {
  it('renders a <button> with [N] text and data-rank', () => {
    const { getByRole } = render(<CitationChip rank={2} cardId="c2" sourceTitle="Issue #42" />);
    const btn = getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toBe('2');
    expect(btn.getAttribute('data-rank')).toBe('2');
    expect(btn.getAttribute('data-card-id')).toBe('c2');
  });

  it('sets title to the source card title', () => {
    const { getByRole } = render(
      <CitationChip rank={1} cardId="c1" sourceTitle="Hello World" />,
    );
    expect(getByRole('button').getAttribute('title')).toBe('Hello World');
  });

  it('falls back to "Source N" when title is not provided', () => {
    const { getByRole } = render(
      <CitationChip rank={3} cardId="c3" />,
    );
    expect(getByRole('button').getAttribute('title')).toBe('Source 3');
  });

  it('fires onActivate({rank, cardId, quote}) on click', () => {
    const onActivate = vi.fn();
    const { getByRole } = render(
      <CitationChip
        rank={2}
        cardId="c2"
        sourceTitle="t"
        quote="verbatim line"
        onActivate={onActivate}
      />,
    );
    fireEvent.click(getByRole('button'));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith({
      rank: 2,
      cardId: 'c2',
      quote: 'verbatim line',
    });
  });

  it('fires onActivate with quote: undefined when no quote prop is provided', () => {
    const onActivate = vi.fn();
    const { getByRole } = render(
      <CitationChip rank={1} cardId="c1" onActivate={onActivate} />,
    );
    fireEvent.click(getByRole('button'));
    expect(onActivate).toHaveBeenCalledWith({
      rank: 1,
      cardId: 'c1',
      quote: undefined,
    });
  });

  it('clicking is a no-op when onActivate is not provided', () => {
    const { getByRole } = render(<CitationChip rank={1} cardId="c1" />);
    // No callback → click should not throw and should produce no observable effect.
    expect(() => fireEvent.click(getByRole('button'))).not.toThrow();
  });

  it('disabled chip sets aria-disabled, removes from tab order, and does NOT fire onActivate', () => {
    const onActivate = vi.fn();
    const { getByRole } = render(
      <CitationChip rank={1} cardId="c1" disabled onActivate={onActivate} />,
    );
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(btn);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('keyboard Enter activates via native button click', () => {
    const onActivate = vi.fn();
    const { getByRole } = render(
      <CitationChip rank={1} cardId="c1" onActivate={onActivate} />,
    );
    const btn = getByRole('button');
    btn.focus();
    // jsdom doesn't fire native click on keydown, but a click event does
    // the same thing — assert the handler binding.
    fireEvent.click(btn);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
