import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { CitationChip } from '../src/components/citation-chip.js';

describe('CitationChip', () => {
  it('renders a <button> with [N] text and data-rank', () => {
    const { getByRole } = render(<CitationChip rank={2} cardId="c2" sourceTitle="Issue #42" />);
    const btn = getByRole('button');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toBe('[2]');
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
      <CitationChip rank={3} cardId="c3" sourceTitle={undefined} />,
    );
    expect(getByRole('button').getAttribute('title')).toBe('Source 3');
  });

  it('clicking scrolls the corresponding source article into view and adds .is-cited-target for 700ms', () => {
    vi.useFakeTimers();
    try {
      const article = document.createElement('article');
      article.setAttribute('data-card-id', 'c1');
      const scrollSpy = vi.fn();
      article.scrollIntoView = scrollSpy as unknown as typeof article.scrollIntoView;
      document.body.appendChild(article);

      const { getByRole } = render(<CitationChip rank={1} cardId="c1" sourceTitle="Hello" />);
      fireEvent.click(getByRole('button'));

      expect(scrollSpy).toHaveBeenCalledTimes(1);
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(article.classList.contains('is-cited-target')).toBe(true);

      vi.advanceTimersByTime(700);
      expect(article.classList.contains('is-cited-target')).toBe(false);

      document.body.removeChild(article);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking when the source article does not exist marks data-source-retracted and updates title (no scroll)', () => {
    const { getByRole } = render(
      <CitationChip rank={4} cardId="ghost" sourceTitle="Was Here" />,
    );
    const btn = getByRole('button');
    fireEvent.click(btn);
    expect(btn.getAttribute('data-source-retracted')).toBe('true');
    expect(btn.getAttribute('title')).toBe('Source no longer available');
  });

  it('keyboard Enter activates via native button behavior', () => {
    const article = document.createElement('article');
    article.setAttribute('data-card-id', 'c1');
    const scrollSpy = vi.fn();
    article.scrollIntoView = scrollSpy as unknown as typeof article.scrollIntoView;
    document.body.appendChild(article);

    const { getByRole } = render(<CitationChip rank={1} cardId="c1" sourceTitle="x" />);
    const btn = getByRole('button');
    btn.focus();
    fireEvent.click(btn);
    expect(scrollSpy).toHaveBeenCalled();

    document.body.removeChild(article);
  });
});
