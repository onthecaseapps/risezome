import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SynthesisStream } from '../src/components/synthesis-stream.js';
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
    accumulatedText: '',
    streaming: true,
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

describe('SynthesisStream', () => {
  it('renders nothing when there are no syntheses', () => {
    const { container } = render(
      <AppStateProvider initial={initialAppState}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelectorAll('article[data-kind="synthesis"]').length).toBe(0);
  });

  it('renders a streaming synthesis with the cursor present', () => {
    const syn = mkSyn({ accumulatedText: 'Partial answer', streaming: true });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('article[data-kind="synthesis"]')).not.toBeNull();
    expect(container.querySelector('.synthesis-cursor')).not.toBeNull();
    expect(container.textContent).toContain('Partial answer');
  });

  it('hides cursor when streaming = false and renders citations', () => {
    const syn = mkSyn({
      accumulatedText: 'Done answer [1].',
      streaming: false,
      citations: [{ rank: 1, cardId: 'src1', position: 0 }],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('.synthesis-cursor')).toBeNull();
    const chip = container.querySelector('button.citation-chip');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-rank')).toBe('1');
    expect(chip?.getAttribute('data-card-id')).toBe('src1');
  });

  it('parses [N] tokens from streaming text into inline citation chips', () => {
    const syn = mkSyn({
      accumulatedText: 'See [1] for context.',
      streaming: true,
      citations: [],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    // The inline chip is rendered in place of the [1] token in the body
    const chips = container.querySelectorAll('button.citation-chip');
    expect(chips.length).toBeGreaterThanOrEqual(1);
  });

  it('drops out-of-range [N] citations from the rendered text on done', () => {
    const syn = mkSyn({
      accumulatedText: 'Answer with bogus [9] and valid [1].',
      streaming: false,
      citations: [{ rank: 1, cardId: 'src1', position: 0 }],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    const body = container.querySelector('.synthesis-body')?.textContent ?? '';
    // [9] should be scrubbed; [1] survives as inline chip text
    expect(body).not.toContain('[9]');
  });

  it('renders consolidated source cards beneath the answer when finished', () => {
    const syn = mkSyn({
      accumulatedText: 'Answer body.',
      streaming: false,
      sourceCardIds: ['src1'],
      citations: [],
    });
    const { container } = render(
      <AppStateProvider
        initial={stateWith({ cards: [mkCard({ cardId: 'src1' })], syntheses: [syn] })}
      >
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('.synthesis-sources')).not.toBeNull();
    expect(
      container.querySelector('.synthesis-sources article[data-card-id="src1"]'),
    ).not.toBeNull();
  });

  it('does not render consolidated sources while streaming', () => {
    const syn = mkSyn({
      accumulatedText: 'Streaming…',
      streaming: true,
      sourceCardIds: ['src1'],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('.synthesis-sources')).toBeNull();
  });

  it('U3 integration: click inline chip expands the matching source with the quote highlighted', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const card = mkCard({ cardId: 'src1', body: 'preamble edition = "2021" tail' });
    const syn = mkSyn({
      accumulatedText: 'See [1] for the line.',
      streaming: false,
      sourceCardIds: ['src1'],
      citations: [{ rank: 1, cardId: 'src1', position: 4, quote: 'edition = "2021"' }],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [card], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    // Source starts collapsed (no .source-body inside src1's source-card-expanded).
    const sourceArticle = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"]',
    );
    expect(sourceArticle).not.toBeNull();
    expect(sourceArticle?.querySelector('.source-body')).toBeNull();

    // Click the inline chip in the answer body.
    const inlineChip = container.querySelector(
      '.synthesis-body button.citation-chip',
    );
    expect(inlineChip).not.toBeNull();
    fireEvent.click(inlineChip!);

    // Source is now expanded and the quote is highlighted.
    const body = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"] .source-body',
    );
    expect(body).not.toBeNull();
    const mark = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"] mark.quote-highlight',
    );
    expect(mark?.textContent).toBe('edition = "2021"');

    // Re-clicking the same chip collapses.
    fireEvent.click(inlineChip!);
    expect(
      container.querySelector(
        'article.source-card-expanded[data-card-id="src1"] .source-body',
      ),
    ).toBeNull();
  });

  it('U4: synthesisStart → synthesisDelta transitions placeholder → streaming in place (no remount)', async () => {
    const { act, fireEvent } = await import('@testing-library/react');
    void fireEvent;
    const { useAppDispatch } = await import('../src/state/app-state.js');
    // Harness component that exposes the dispatch fn to the test via a ref.
    let capturedDispatch: ReturnType<typeof useAppDispatch> | null = null;
    function DispatchTap(): null {
      capturedDispatch = useAppDispatch();
      return null;
    }
    const placeholderSyn: SynthesisRecord = mkSyn({
      synthesisId: 'live',
      sourceCardIds: ['src1'],
      streaming: true,
      accumulatedText: '',
      citations: [],
    });
    const { container } = render(
      <AppStateProvider
        initial={stateWith({
          cards: [mkCard({ cardId: 'src1', title: 'Search target' })],
          syntheses: [placeholderSyn],
        })}
      >
        <SynthesisStream />
        <DispatchTap />
      </AppStateProvider>,
    );
    // Placeholder rendered. Capture the article DOM node so we can
    // assert identity preservation across the dispatch.
    const articleAtPlaceholder = container.querySelector('article[data-kind="synthesis"]');
    expect(articleAtPlaceholder?.getAttribute('data-phase')).toBe('placeholder');
    expect(container.querySelector('.synthesis-skeleton')).not.toBeNull();
    expect(container.querySelector('.synthesis-placeholder-sources')?.textContent).toContain(
      'Search target',
    );

    // Dispatch a synthesisDelta on the SAME provider — useReducer updates
    // in place; the React tree re-renders without remounting.
    act(() => {
      capturedDispatch!({
        type: 'synthesisDelta',
        delta: { synthesisId: 'live', delta: 'Hello' },
      });
    });
    const articleAtStreaming = container.querySelector('article[data-kind="synthesis"]');
    expect(articleAtStreaming).toBe(articleAtPlaceholder); // SAME DOM node — no remount.
    expect(articleAtStreaming?.getAttribute('data-phase')).toBe('streaming');
    expect(container.querySelector('.synthesis-skeleton')).toBeNull();
    expect(container.querySelector('.synthesis-body')?.textContent).toContain('Hello');
  });

  it('U3: per-occurrence quotes — same source, two chips, two different highlights', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const card = mkCard({
      cardId: 'src1',
      body: 'first thing happens and then second thing happens',
    });
    const syn = mkSyn({
      accumulatedText: 'A [1] then B [1].',
      streaming: false,
      sourceCardIds: ['src1'],
      citations: [
        { rank: 1, cardId: 'src1', position: 2, quote: 'first thing' },
        { rank: 1, cardId: 'src1', position: 13, quote: 'second thing' },
      ],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [card], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    const inlineChips = container.querySelectorAll(
      '.synthesis-body button.citation-chip',
    );
    expect(inlineChips.length).toBe(2);

    fireEvent.click(inlineChips[0]!);
    expect(
      container.querySelector(
        'article.source-card-expanded[data-card-id="src1"] mark.quote-highlight',
      )?.textContent,
    ).toBe('first thing');

    fireEvent.click(inlineChips[1]!);
    expect(
      container.querySelector(
        'article.source-card-expanded[data-card-id="src1"] mark.quote-highlight',
      )?.textContent,
    ).toBe('second thing');
  });
});
