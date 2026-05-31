import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PinnedSynthesesSection } from '../src/components/pinned-syntheses-section.js';
import {
  AppStateProvider,
  initialAppState,
  type CardRecord,
  type SynthesisRecord,
} from '../src/state/app-state.js';
import type { CardEvent } from '../src/types.js';

function mkCard(over: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'src1',
    docId: 'd',
    source: 'github',
    type: 'issue',
    title: 'Source title',
    snippet: 's',
    body: 'b',
    score: 0.9,
    rank: 1,
    metadata: {},
    surfacedAt: 0,
    triggeredBy: 'window',
    traceId: 't',
    ...over,
  };
}

function mkSyn(over: Partial<SynthesisRecord> = {}): SynthesisRecord {
  return {
    synthesisId: 's1',
    sourceCardIds: ['src1'],
    traceId: 't',
    accumulatedText: 'Answer',
    streaming: false,
    citations: [],
    pinned: false,
    pinnedAt: null,
    ...over,
  };
}

function stateWith({
  cards = [],
  syntheses = [],
}: {
  cards?: CardEvent[];
  syntheses?: SynthesisRecord[];
}) {
  const cardMap = new Map<string, CardRecord>();
  for (const c of cards) cardMap.set(c.cardId, { card: c, pinned: false });
  const synMap = new Map<string, SynthesisRecord>();
  for (const s of syntheses) synMap.set(s.synthesisId, s);
  return { ...initialAppState, cards: cardMap, syntheses: synMap };
}

describe('PinnedSynthesesSection', () => {
  it('renders nothing when no syntheses are pinned', () => {
    const { container } = render(
      <AppStateProvider initial={stateWith({ syntheses: [mkSyn()] })}>
        <PinnedSynthesesSection />
      </AppStateProvider>,
    );
    expect(container.querySelector('.pinned-syntheses')).toBeNull();
  });

  it('renders only pinned syntheses; unpinned are absent', () => {
    const pinned = mkSyn({ synthesisId: 'a', pinned: true, pinnedAt: '2026-05-31T12:00:00.000Z' });
    const unpinned = mkSyn({ synthesisId: 'b', pinned: false });
    const { container } = render(
      <AppStateProvider
        initial={stateWith({ cards: [mkCard()], syntheses: [pinned, unpinned] })}
      >
        <PinnedSynthesesSection />
      </AppStateProvider>,
    );
    const articles = container.querySelectorAll('article[data-kind="synthesis"]');
    expect(articles.length).toBe(1);
    expect(articles[0]?.getAttribute('data-synthesis-id')).toBe('a');
  });

  it('orders pinned syntheses by pinnedAt DESC (most recently pinned at top)', () => {
    const older = mkSyn({ synthesisId: 'older', pinned: true, pinnedAt: '2026-05-30T10:00:00.000Z' });
    const newer = mkSyn({ synthesisId: 'newer', pinned: true, pinnedAt: '2026-05-31T15:00:00.000Z' });
    const { container } = render(
      <AppStateProvider
        initial={stateWith({ cards: [mkCard()], syntheses: [older, newer] })}
      >
        <PinnedSynthesesSection />
      </AppStateProvider>,
    );
    const articles = container.querySelectorAll('article[data-kind="synthesis"]');
    expect(articles[0]?.getAttribute('data-synthesis-id')).toBe('newer');
    expect(articles[1]?.getAttribute('data-synthesis-id')).toBe('older');
  });

  it('renders a "Pinned (N)" header reflecting the count', () => {
    const a = mkSyn({ synthesisId: 'a', pinned: true, pinnedAt: '2026-05-31T12:00:00.000Z' });
    const b = mkSyn({ synthesisId: 'b', pinned: true, pinnedAt: '2026-05-31T13:00:00.000Z' });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [a, b] })}>
        <PinnedSynthesesSection />
      </AppStateProvider>,
    );
    expect(container.querySelector('.pinned-syntheses-label')?.textContent).toBe('Pinned (2)');
  });
});
