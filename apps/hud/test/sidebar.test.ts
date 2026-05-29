// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sidebar } from '../src/sidebar.js';
import type { CardEvent, GapEvent } from '../src/types.js';

function makeCard(overrides: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'c1',
    docId: 'gh:repo#issue:1',
    source: 'github',
    type: 'issue',
    title: 'Auth refactor',
    snippet: 'Replace JWT middleware',
    score: 0.87,
    metadata: {},
    surfacedAt: 1_000,
    triggeredBy: 'window',
    traceId: 't1',
    ...overrides,
  };
}

function makeGap(overrides: Partial<GapEvent> = {}): GapEvent {
  return {
    gapId: 'g1',
    meetingId: 'm:1',
    question: "what's the rollout plan?",
    contextWindow: '… surrounding context …',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('Sidebar', () => {
  let streamEl: HTMLElement;
  let pinnedEl: HTMLElement;
  let sidebar: Sidebar;

  beforeEach(() => {
    document.body.innerHTML = '<div id="stream"></div><div id="pinned"></div>';
    streamEl = document.getElementById('stream')!;
    pinnedEl = document.getElementById('pinned')!;
    sidebar = new Sidebar({ streamEl, pinnedEl });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders 5 cards in insertion order', () => {
    for (let i = 0; i < 5; i++) {
      sidebar.renderCard(
        makeCard({ cardId: `c${String(i)}`, docId: `d${String(i)}`, title: `T${String(i)}` }),
      );
    }
    const titles = [...streamEl.querySelectorAll('.title')].map((el) => el.textContent);
    expect(titles).toEqual(['T0', 'T1', 'T2', 'T3', 'T4']);
    expect(sidebar.visibleCardCount()).toBe(5);
  });

  it('cardUpdated changes score and triggeredBy in place', () => {
    sidebar.renderCard(makeCard({ triggeredBy: 'question-provisional' }));
    expect(streamEl.querySelector('.card.provisional')).not.toBeNull();
    sidebar.updateCard({ cardId: 'c1', score: 0.5, triggeredBy: 'question' });
    const scoreEl = streamEl.querySelector('.score');
    expect(scoreEl?.textContent).toBe('50%');
    expect(streamEl.querySelector('.card.provisional')).toBeNull();
  });

  it('cardRetracted removes the card', () => {
    sidebar.renderCard(makeCard());
    expect(sidebar.visibleCardCount()).toBe(1);
    sidebar.retractCard({ cardId: 'c1', reason: 'verifier-downgraded' });
    expect(sidebar.visibleCardCount()).toBe(0);
    expect(streamEl.querySelector('.card')).toBeNull();
  });

  it('pin moves card to pinned section and remains visible across 50 more cards', () => {
    sidebar.renderCard(makeCard());
    const pinBtn = streamEl.querySelector('button')!;
    pinBtn.click();
    expect(pinnedEl.querySelector('.card.pinned')).not.toBeNull();
    for (let i = 0; i < 50; i++) {
      sidebar.renderCard(makeCard({ cardId: `extra${String(i)}`, docId: `d${String(i)}` }));
    }
    // Pinned card is still in pinnedEl, not absorbed into stream
    expect(pinnedEl.querySelector('[data-card-id="c1"]')).not.toBeNull();
    expect(streamEl.querySelector('[data-card-id="c1"]')).toBeNull();
  });

  it('renderCard with provisional triggeredBy applies the provisional class', () => {
    sidebar.renderCard(makeCard({ triggeredBy: 'question-provisional' }));
    expect(streamEl.querySelector('.card.provisional')).not.toBeNull();
  });

  it('renderCard with missing snippet renders a placeholder, not a crash', () => {
    sidebar.renderCard(makeCard({ snippet: '' }));
    const snippet = streamEl.querySelector('.snippet');
    expect(snippet).not.toBeNull();
    expect(snippet?.textContent ?? '').toBe('');
  });

  it('renderGap renders a gap card with question and log/dismiss actions', () => {
    sidebar.renderGap(makeGap());
    const gap = streamEl.querySelector('.card.gap');
    expect(gap).not.toBeNull();
    expect(gap?.querySelector('.title')?.textContent).toBe("what's the rollout plan?");
    expect(gap?.querySelectorAll('button')).toHaveLength(2);
  });

  it('dismiss button removes a gap from the DOM', () => {
    sidebar.renderGap(makeGap());
    expect(sidebar.visibleGapCount()).toBe(1);
    const dismissBtn = [...streamEl.querySelectorAll('button')].find(
      (b) => b.textContent === 'Dismiss',
    );
    dismissBtn?.click();
    expect(sidebar.visibleGapCount()).toBe(0);
  });

  it('renderCard with duplicate cardId is a no-op (no duplicates)', () => {
    sidebar.renderCard(makeCard());
    sidebar.renderCard(makeCard());
    expect(sidebar.visibleCardCount()).toBe(1);
  });
});
