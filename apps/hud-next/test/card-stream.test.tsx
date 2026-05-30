import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CardStream } from '../app/components/card-stream';
import { AppStateProvider } from '../app/state/app-state';
import type { AppState, CardRecord } from '../app/state/app-state';
import { initialAppState } from '../app/state/app-state';
import type { CardEvent } from '../app/types';

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

function stateWithCards(cards: CardEvent[]): AppState {
  const map = new Map<string, CardRecord>();
  for (const c of cards) map.set(c.cardId, { card: c, pinned: false });
  return { ...initialAppState, cards: map };
}

describe('CardStream', () => {
  it('renders zero cards as no <article> elements', () => {
    const { container } = render(
      <AppStateProvider initial={initialAppState}>
        <CardStream />
      </AppStateProvider>,
    );
    expect(container.querySelectorAll('article.card').length).toBe(0);
  });

  it('renders un-pinned cards from state.cards', () => {
    const cards = [mkCard({ cardId: 'a' }), mkCard({ cardId: 'b', title: 'B' })];
    const { container } = render(
      <AppStateProvider initial={stateWithCards(cards)}>
        <CardStream />
      </AppStateProvider>,
    );
    const articles = container.querySelectorAll('article.card');
    expect(articles.length).toBe(2);
  });

  it('renders cards newest-first (reverse insertion order)', () => {
    const cards = [mkCard({ cardId: 'first', title: 'First' }), mkCard({ cardId: 'last', title: 'Last' })];
    const { container } = render(
      <AppStateProvider initial={stateWithCards(cards)}>
        <CardStream />
      </AppStateProvider>,
    );
    const titles = Array.from(container.querySelectorAll('.title-link')).map((el) => el.textContent);
    expect(titles).toEqual(['Last', 'First']);
  });

  it('skips pinned cards (they belong to PinnedSection)', () => {
    const state = stateWithCards([mkCard({ cardId: 'a' }), mkCard({ cardId: 'b' })]);
    const cards = new Map(state.cards);
    cards.set('a', { card: mkCard({ cardId: 'a' }), pinned: true });
    const { container } = render(
      <AppStateProvider initial={{ ...state, cards }}>
        <CardStream />
      </AppStateProvider>,
    );
    const ids = Array.from(container.querySelectorAll('article.card')).map((el) =>
      el.getAttribute('data-card-id'),
    );
    expect(ids).toEqual(['b']);
  });
});
