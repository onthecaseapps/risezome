import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PinnedSection } from '../src/components/pinned-section.js';
import { AppStateProvider, initialAppState } from '../src/state/app-state.js';
import type { CardEvent } from '../src/types.js';

function mkCard(over: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'c1',
    docId: 'd1',
    source: 'github',
    type: 'issue',
    title: 'A',
    snippet: 's',
    score: 0.9,
    rank: 1,
    metadata: {},
    surfacedAt: 0,
    triggeredBy: 'window',
    traceId: 't',
    ...over,
  };
}

describe('PinnedSection', () => {
  it('renders empty section when no cards are pinned', () => {
    const { container } = render(
      <AppStateProvider initial={initialAppState}>
        <PinnedSection />
      </AppStateProvider>,
    );
    expect(container.querySelectorAll('article.card').length).toBe(0);
    expect(container.querySelector('section#pinned-section')).not.toBeNull();
  });

  it('renders only the cards marked pinned', () => {
    const cards = new Map([
      ['a', { card: mkCard({ cardId: 'a', title: 'A' }), pinned: true }],
      ['b', { card: mkCard({ cardId: 'b', title: 'B' }), pinned: false }],
      ['c', { card: mkCard({ cardId: 'c', title: 'C' }), pinned: true }],
    ]);
    const { container } = render(
      <AppStateProvider initial={{ ...initialAppState, cards }}>
        <PinnedSection />
      </AppStateProvider>,
    );
    const ids = Array.from(container.querySelectorAll('article.card')).map((el) =>
      el.getAttribute('data-card-id'),
    );
    expect(ids).toEqual(['a', 'c']);
    expect(container.querySelectorAll('article.card.pinned').length).toBe(2);
  });
});
