// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../src/sidebar.js';
import type {
  CardEvent,
  GapEvent,
  SynthesisDeltaEvent,
  SynthesisDoneEvent,
  SynthesisStartEvent,
} from '../src/types.js';

function makeCard(overrides: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'c1',
    docId: 'gh:repo#issue:1',
    source: 'github',
    type: 'issue',
    title: 'Auth refactor',
    snippet: 'Replace JWT middleware',
    score: 0.87,
    rank: 1,
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
    document.body.innerHTML =
      '<button id="new-content-badge" class="hidden"><span id="new-content-count">0</span></button>' +
      '<div id="stream"></div>' +
      '<div id="pinned"></div>' +
      '<div id="synthesis-announce" aria-live="polite"></div>';
    streamEl = document.getElementById('stream')!;
    pinnedEl = document.getElementById('pinned')!;
    sidebar = new Sidebar({ streamEl, pinnedEl });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders new cards above older ones (newest-first)', () => {
    for (let i = 0; i < 5; i++) {
      sidebar.renderCard(
        makeCard({ cardId: `c${String(i)}`, docId: `d${String(i)}`, title: `T${String(i)}` }),
      );
    }
    const titles = [...streamEl.querySelectorAll('.title')].map((el) => el.textContent);
    expect(titles).toEqual(['T4', 'T3', 'T2', 'T1', 'T0']);
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

  // --- U6 synthesis card tests ---

  function makeStart(overrides: Partial<SynthesisStartEvent> = {}): SynthesisStartEvent {
    return {
      synthesisId: 'syn_1',
      sourceCardIds: ['c1', 'c2', 'c3'],
      traceId: 't1',
      ...overrides,
    };
  }
  function makeDelta(text: string, synthesisId = 'syn_1'): SynthesisDeltaEvent {
    return { synthesisId, delta: text };
  }
  function makeDone(citations: number[], synthesisId = 'syn_1'): SynthesisDoneEvent {
    return {
      synthesisId,
      stopReason: 'end_turn',
      citations,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ttftMs: 100,
      latencyMs: 500,
    };
  }

  it('synthesisStart prepends a synthesis card above raw cards with aria-live=off', () => {
    sidebar.renderCard(makeCard({ cardId: 'c1' }));
    sidebar.renderSynthesisStart(makeStart());

    const first = streamEl.firstElementChild;
    expect(first?.classList.contains('synthesis')).toBe(true);
    expect(first?.getAttribute('aria-live')).toBe('off');
    expect(streamEl.querySelector('.ai-label')?.textContent).toBe('AI SUMMARY');
    expect(streamEl.querySelector('.synthesis-cursor')).not.toBeNull();
    expect(sidebar.visibleSynthesisCount()).toBe(1);
  });

  it('appendSynthesisDelta accumulates text via textContent (no innerHTML rewrite)', () => {
    sidebar.renderSynthesisStart(makeStart());
    const bodyEl = streamEl.querySelector<HTMLElement>('.synthesis-body')!;
    const initialNode = bodyEl;

    sidebar.appendSynthesisDelta(makeDelta('Hello '));
    sidebar.appendSynthesisDelta(makeDelta('world.'));

    expect(bodyEl.textContent).toBe('Hello world.');
    // Identity preserved. we didn't replace the element.
    expect(streamEl.querySelector<HTMLElement>('.synthesis-body')).toBe(initialNode);
  });

  it('eagerly renders citation chips per [N] token as deltas arrive', () => {
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1', 'c2', 'c3'] }));
    sidebar.appendSynthesisDelta(makeDelta('First [1] '));
    expect(streamEl.querySelectorAll('.citation-chip').length).toBe(1);
    sidebar.appendSynthesisDelta(makeDelta('then [3].'));
    const chips = streamEl.querySelectorAll<HTMLElement>('.citation-chip');
    expect(chips.length).toBe(2);
    expect([...chips].map((c) => c.textContent)).toEqual(['[1]', '[3]']);
  });

  it('out-of-range [N] citations do NOT render chips (only sourceCardIds.length valid)', () => {
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1'] }));
    sidebar.appendSynthesisDelta(makeDelta('Per [5] and [1].'));
    const chips = streamEl.querySelectorAll<HTMLElement>('.citation-chip');
    expect(chips.length).toBe(1);
    expect(chips[0]!.textContent).toBe('[1]');
  });

  it('finalizeSynthesis removes cursor, reconciles chips, announces final text', () => {
    sidebar.renderCard(makeCard({ cardId: 'c2' }));
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1', 'c2', 'c3'] }));
    sidebar.appendSynthesisDelta(makeDelta('A [1] B [2] C [3].'));
    expect(streamEl.querySelectorAll('.citation-chip').length).toBe(3);

    // Final says citations are [2] only. chips 1 and 3 should be removed.
    sidebar.finalizeSynthesis(makeDone([2]));
    expect(streamEl.querySelector('.synthesis-cursor')).toBeNull();
    const chips = streamEl.querySelectorAll<HTMLElement>('.citation-chip');
    expect([...chips].map((c) => c.textContent)).toEqual(['[2]']);

    const announce = document.getElementById('synthesis-announce');
    expect(announce?.textContent).toBe('A [1] B [2] C [3].');
  });

  it('citation chip click scrolls the matching raw card into view', () => {
    sidebar.renderCard(makeCard({ cardId: 'c1' }));
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1'] }));
    sidebar.appendSynthesisDelta(makeDelta('Per [1].'));

    const raw = streamEl.querySelector<HTMLElement>('[data-card-id="c1"]')!;
    const scrollMock = vi.fn();
    raw.scrollIntoView = scrollMock as unknown as Element['scrollIntoView'];

    const chip = streamEl.querySelector<HTMLElement>('.citation-chip')!;
    chip.click();

    expect(scrollMock).toHaveBeenCalled();
  });

  it('removeSynthesis drops the card silently (used by both error and retract paths)', () => {
    sidebar.renderSynthesisStart(makeStart());
    sidebar.appendSynthesisDelta(makeDelta('text'));
    sidebar.removeSynthesis('syn_1');
    expect(streamEl.querySelector('.card.synthesis')).toBeNull();
    expect(sidebar.visibleSynthesisCount()).toBe(0);
  });

  it('retractSynthesis is equivalent to removeSynthesis', () => {
    sidebar.renderSynthesisStart(makeStart());
    sidebar.retractSynthesis({ synthesisId: 'syn_1', reason: 'source-retracted' });
    expect(streamEl.querySelector('.card.synthesis')).toBeNull();
  });

  it('appendSynthesisDelta on an unknown synthesisId is a no-op (no card created)', () => {
    sidebar.appendSynthesisDelta(makeDelta('text', 'unknown'));
    expect(streamEl.querySelector('.card.synthesis')).toBeNull();
  });

  it('handles two concurrent syntheses with distinct ids correctly', () => {
    sidebar.renderSynthesisStart(makeStart({ synthesisId: 'syn_a', sourceCardIds: ['c1'] }));
    sidebar.renderSynthesisStart(makeStart({ synthesisId: 'syn_b', sourceCardIds: ['c2'] }));
    expect(sidebar.visibleSynthesisCount()).toBe(2);

    sidebar.appendSynthesisDelta(makeDelta('A', 'syn_a'));
    sidebar.appendSynthesisDelta(makeDelta('B', 'syn_b'));
    sidebar.appendSynthesisDelta(makeDelta('B2', 'syn_b'));

    const a = streamEl.querySelector<HTMLElement>('[data-synthesis-id="syn_a"] .synthesis-body')!;
    const b = streamEl.querySelector<HTMLElement>('[data-synthesis-id="syn_b"] .synthesis-body')!;
    expect(a.textContent).toBe('A');
    expect(b.textContent).toBe('BB2');

    sidebar.removeSynthesis('syn_a');
    expect(sidebar.visibleSynthesisCount()).toBe(1);
    expect(streamEl.querySelector('[data-synthesis-id="syn_b"]')).not.toBeNull();
  });

  // --- Empty-state placeholder ---

  it('shows the empty-state placeholder when the stream has no content', () => {
    const empty = streamEl.querySelector<HTMLElement>('.empty-state');
    expect(empty).not.toBeNull();
    expect(empty!.querySelector('.empty-state-msg')?.textContent).toBeTruthy();
  });

  it('hides the empty-state placeholder when a card arrives, restores when all cards are gone', async () => {
    sidebar.renderCard(makeCard({ cardId: 'c1' }));
    // happy-dom's MutationObserver fires asynchronously; flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(streamEl.querySelector('.empty-state')).toBeNull();

    sidebar.retractCard({ cardId: 'c1', reason: 'manual-dismiss' });
    await new Promise((r) => setTimeout(r, 0));
    expect(streamEl.querySelector('.empty-state')).not.toBeNull();
  });

  // --- U6+UI3: consolidation ---

  it('finalizeSynthesis moves source cards from the stream into a sources grid inside the synthesis card', () => {
    sidebar.renderCard(makeCard({ cardId: 'c1', docId: 'd1', title: 'Card 1' }));
    sidebar.renderCard(makeCard({ cardId: 'c2', docId: 'd2', title: 'Card 2' }));
    sidebar.renderCard(makeCard({ cardId: 'c3', docId: 'd3', title: 'Card 3' }));
    // Initially 3 raw cards in the stream.
    expect(streamEl.querySelectorAll<HTMLElement>('.card:not(.synthesis)').length).toBe(3);

    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1', 'c2', 'c3'] }));
    sidebar.appendSynthesisDelta(makeDelta('Answer [1][2][3].'));
    sidebar.finalizeSynthesis(makeDone([1, 2, 3]));

    // After consolidation: raw cards live INSIDE the synthesis card, not as
    // direct siblings of the stream root.
    const directRawCards = streamEl.querySelectorAll<HTMLElement>(
      '#stream > .card:not(.synthesis)',
    );
    expect(directRawCards.length).toBe(0);

    const synthEl = streamEl.querySelector<HTMLElement>('.card.synthesis')!;
    const grid = synthEl.querySelector<HTMLElement>('.synthesis-sources-grid')!;
    expect(grid.querySelectorAll('.card.consolidated').length).toBe(3);
    const label = synthEl.querySelector<HTMLElement>('.synthesis-sources-label');
    expect(label?.textContent).toBe('Sources (3)');
  });

  it('removeSynthesis after consolidation restores the raw cards to the stream', () => {
    sidebar.renderCard(makeCard({ cardId: 'c1', docId: 'd1', title: 'Card 1' }));
    sidebar.renderCard(makeCard({ cardId: 'c2', docId: 'd2', title: 'Card 2' }));
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1', 'c2'] }));
    sidebar.finalizeSynthesis(makeDone([1, 2]));
    expect(streamEl.querySelectorAll('#stream > .card:not(.synthesis)').length).toBe(0);

    sidebar.removeSynthesis('syn_1');
    // Synthesis card gone; raw cards back as direct children of stream.
    expect(streamEl.querySelector('.card.synthesis')).toBeNull();
    const restored = streamEl.querySelectorAll<HTMLElement>('#stream > .card:not(.synthesis)');
    expect(restored.length).toBe(2);
    // Cards no longer carry the consolidated marker class.
    for (const c of restored) expect(c.classList.contains('consolidated')).toBe(false);
  });

  it('pinned cards are NOT consolidated (they stay in the pinned section)', () => {
    sidebar.renderCard(makeCard({ cardId: 'c1', docId: 'd1' }));
    sidebar.togglePin('c1');
    sidebar.renderCard(makeCard({ cardId: 'c2', docId: 'd2' }));
    expect(pinnedEl.querySelectorAll('.card').length).toBe(1);

    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1', 'c2'] }));
    sidebar.finalizeSynthesis(makeDone([1, 2]));

    // c1 is pinned → still in #pinned, NOT moved into the synthesis grid.
    expect(pinnedEl.querySelector('[data-card-id="c1"]')).not.toBeNull();
    // c2 is unpinned → moved into the grid.
    const grid = streamEl.querySelector<HTMLElement>('.synthesis-sources-grid')!;
    expect(grid.querySelector('[data-card-id="c2"]')).not.toBeNull();
    expect(grid.querySelectorAll('.card.consolidated').length).toBe(1);
  });

  // --- UI4: hover-safe scroll + pulsing new-content badge ---

  function fireMouseEvent(el: HTMLElement, type: 'mouseenter' | 'mouseleave'): void {
    el.dispatchEvent(new Event(type));
  }

  it('scrolls the stream to top when a new card arrives and mouse is NOT over the stream', () => {
    const scrollMock = vi.fn();
    streamEl.scrollIntoView = scrollMock as unknown as Element['scrollIntoView'];
    sidebar.renderCard(makeCard());
    expect(scrollMock).toHaveBeenCalled();
    const badge = document.getElementById('new-content-badge')!;
    expect(badge.classList.contains('hidden')).toBe(true);
  });

  it('does NOT scroll while hovering. shows pulsing badge with new count', () => {
    fireMouseEvent(streamEl, 'mouseenter');
    const scrollMock = vi.fn();
    streamEl.scrollIntoView = scrollMock as unknown as Element['scrollIntoView'];

    sidebar.renderCard(makeCard({ cardId: 'c1' }));
    sidebar.renderCard(makeCard({ cardId: 'c2' }));

    expect(scrollMock).not.toHaveBeenCalled();
    const badge = document.getElementById('new-content-badge')!;
    expect(badge.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('new-content-count')!.textContent).toBe('2');
  });

  it('mouseleave with pending new content scrolls to top and hides the badge', () => {
    fireMouseEvent(streamEl, 'mouseenter');
    sidebar.renderCard(makeCard({ cardId: 'c1' }));
    sidebar.renderCard(makeCard({ cardId: 'c2' }));
    const badge = document.getElementById('new-content-badge')!;
    expect(badge.classList.contains('hidden')).toBe(false);

    const scrollMock = vi.fn();
    streamEl.scrollIntoView = scrollMock as unknown as Element['scrollIntoView'];
    fireMouseEvent(streamEl, 'mouseleave');

    expect(scrollMock).toHaveBeenCalled();
    expect(badge.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('new-content-count')!.textContent).toBe('0');
  });

  it('badge click flushes pending state and scrolls to top', () => {
    fireMouseEvent(streamEl, 'mouseenter');
    sidebar.renderCard(makeCard());
    const scrollMock = vi.fn();
    streamEl.scrollIntoView = scrollMock as unknown as Element['scrollIntoView'];
    const badge = document.getElementById('new-content-badge') as HTMLButtonElement;
    badge.click();

    expect(scrollMock).toHaveBeenCalled();
    expect(badge.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('new-content-count')!.textContent).toBe('0');
  });

  it('synthesis card render counts toward the pending new-content total too', () => {
    fireMouseEvent(streamEl, 'mouseenter');
    sidebar.renderCard(makeCard({ cardId: 'c1' }));
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1'] }));
    expect(document.getElementById('new-content-count')!.textContent).toBe('2');
  });

  it('synthesisError after deltas does NOT consolidate (raw cards stay in stream)', () => {
    sidebar.renderCard(makeCard({ cardId: 'c1', docId: 'd1' }));
    sidebar.renderSynthesisStart(makeStart({ sourceCardIds: ['c1'] }));
    sidebar.appendSynthesisDelta(makeDelta('Partial...'));
    // Error path: no finalize, straight to removeSynthesis (which main.ts
    // calls on any synthesisError, including refused).
    sidebar.removeSynthesis('syn_1');
    // Raw card still in the stream, no consolidation footprint anywhere.
    expect(streamEl.querySelector('#stream > [data-card-id="c1"]')).not.toBeNull();
    expect(streamEl.querySelector('.synthesis-sources-grid')).toBeNull();
    expect(streamEl.querySelector('.card.consolidated')).toBeNull();
  });
});
