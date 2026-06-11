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

  it('renders the sources ledger beneath the answer when finished; cited row inside', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const syn = mkSyn({
      accumulatedText: 'Answer body [1].',
      streaming: false,
      sourceCardIds: ['src1'],
      citations: [{ rank: 1, cardId: 'src1', position: 12 }],
    });
    const { container } = render(
      <AppStateProvider
        initial={stateWith({ cards: [mkCard({ cardId: 'src1' })], syntheses: [syn] })}
      >
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('.synthesis-ledger')).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    expect(
      container.querySelector('.synthesis-ledger article[data-card-id="src1"]'),
    ).not.toBeNull();
  });

  it('omits an uncited retrieved source from the ledger', async () => {
    const { fireEvent } = await import('@testing-library/react');
    // src1 is cited, src2 is retrieved but never cited (nor marked) → only src1.
    const syn = mkSyn({
      accumulatedText: 'Answer body [1].',
      streaming: false,
      sourceCardIds: ['src1', 'src2'],
      citations: [{ rank: 1, cardId: 'src1', position: 12 }],
    });
    const { container } = render(
      <AppStateProvider
        initial={stateWith({
          cards: [mkCard({ cardId: 'src1' }), mkCard({ cardId: 'src2' })],
          syntheses: [syn],
        })}
      >
        <SynthesisStream />
      </AppStateProvider>,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    expect(container.querySelector('.synthesis-ledger article[data-card-id="src1"]')).not.toBeNull();
    expect(container.querySelector('.synthesis-ledger article[data-card-id="src2"]')).toBeNull();
    // "grounded in 1 cited" reflects cited, not retrieved (2).
    expect(container.querySelector('.synthesis-grounded')?.textContent).toBe('grounded in 1 cited');
  });

  it('does not render the ledger while streaming', () => {
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
    expect(container.querySelector('.synthesis-ledger')).toBeNull();
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
    // The ledger starts collapsed — no rows in the DOM yet.
    expect(container.querySelector('.synthesis-ledger')?.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('article.source-card-expanded')).toBeNull();

    // Click the inline chip in the answer body — it expands the ledger AND
    // opens the cited row at that occurrence's quote.
    const inlineChip = container.querySelector(
      '.synthesis-body button.citation-chip',
    );
    expect(inlineChip).not.toBeNull();
    fireEvent.click(inlineChip!);

    // Source row is now expanded and the quote is highlighted.
    const body = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"] .source-body',
    );
    expect(body).not.toBeNull();
    const mark = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"] mark.quote-highlight',
    );
    expect(mark?.textContent).toBe('edition = "2021"');

    // Re-clicking the same chip collapses the row (ledger stays open).
    fireEvent.click(inlineChip!);
    expect(
      container.querySelector(
        'article.source-card-expanded[data-card-id="src1"] .source-body',
      ),
    ).toBeNull();
    expect(container.querySelector('.synthesis-ledger')?.getAttribute('data-open')).toBe('true');
  });

  it('clicking a source row expands it with the first cited quote highlighted', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const card = mkCard({ cardId: 'src1', body: 'the full chunk body text' });
    const syn = mkSyn({
      accumulatedText: 'See [1].',
      streaming: false,
      sourceCardIds: ['src1'],
      citations: [{ rank: 1, cardId: 'src1', position: 4, quote: 'full chunk' }],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [card], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );

    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    const toggle = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"] button.source-card-toggle',
    );
    expect(toggle).not.toBeNull();
    expect(
      container.querySelector('article.source-card-expanded[data-card-id="src1"] .source-body'),
    ).toBeNull();

    // Click the card header → expands, body shows, first cited quote highlighted.
    fireEvent.click(toggle!);
    const body = container.querySelector(
      'article.source-card-expanded[data-card-id="src1"] .source-body',
    );
    expect(body).not.toBeNull();
    expect(body?.querySelector('mark.quote-highlight')?.textContent).toBe('full chunk');

    // Click again → collapses.
    fireEvent.click(toggle!);
    expect(
      container.querySelector('article.source-card-expanded[data-card-id="src1"] .source-body'),
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

describe('SynthesisStream — related (additional) sources resolution', () => {
  it('resolves additionalSources refs to cards and renders RELATED ledger rows', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const cited = mkCard();
    const extra = mkCard({ cardId: 'src2', title: 'Corroborating doc', url: 'https://x/doc' });
    const syn = mkSyn({
      sourceCardIds: ['src1', 'src2'],
      accumulatedText: 'Done answer [1].',
      streaming: false,
      citations: [{ rank: 1, cardId: 'src1', position: 0 }],
      additionalSources: [{ cardId: 'src2', rank: 2 }],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [cited, extra], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('.synthesis-ledger')?.textContent).toContain(
      'Grounded in 1 cited + 1 related sources',
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    const related = container.querySelector('.source-card-expanded.is-related');
    expect(related?.querySelector('.source-row-title')?.textContent).toBe('Corroborating doc');
  });

  it('a mark whose card is missing locally is skipped without error (cited-only ledger)', () => {
    const syn = mkSyn({
      sourceCardIds: ['src1', 'src_gone'],
      accumulatedText: 'Done answer [1].',
      streaming: false,
      citations: [{ rank: 1, cardId: 'src1', position: 0 }],
      additionalSources: [{ cardId: 'src_gone', rank: 2 }],
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [mkCard()], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    expect(container.querySelector('article[data-kind="synthesis"]')).not.toBeNull();
    expect(container.querySelector('.synthesis-ledger')?.textContent).not.toContain('related');
  });
});

describe('SynthesisStream — tool source renders as a CITED ledger row', () => {
  it('resolves a rank-1 (tool) citation to the toolSource — no card backs it', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const codeCard = mkCard({ cardId: 'src_code', title: 'search_count.ts', type: 'code' });
    const syn = mkSyn({
      sourceCardIds: ['tool_tr1', 'src_code'],
      traceId: 'tr1',
      accumulatedText: 'There are 32 open issues [1]. Counted by the workspace query [2].',
      streaming: false,
      citations: [
        { rank: 1, cardId: 'tool_tr1', position: 0, quote: '32 open issues' },
        { rank: 2, cardId: 'src_code', position: 10 },
      ],
      toolSource: {
        cardId: 'tool_tr1',
        title: 'Tool: github_count({"state":"open"})',
        body: '32 open issues.',
      },
    });
    const { container } = render(
      <AppStateProvider initial={stateWith({ cards: [codeCard], syntheses: [syn] })}>
        <SynthesisStream />
      </AppStateProvider>,
    );
    // Both chips render — the tool citation is NOT a ghost.
    expect(container.querySelectorAll('button.citation-chip')).toHaveLength(2);
    expect(container.querySelector('.synthesis-grounded')?.textContent).toBe('grounded in 2 cited');

    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    const toolRow = container.querySelector('article.source-card-expanded[data-card-id="tool_tr1"]');
    expect(toolRow).not.toBeNull();
    expect(toolRow?.querySelector('.source-row-badge')?.textContent).toBe('1');
    expect(toolRow?.querySelector('.source-row-status')?.textContent).toBe('Top match');
    expect(toolRow?.querySelector('.source-row-pill')?.textContent).toBe('SKILL');
    expect(toolRow?.querySelector('.source-row-title')?.textContent).toBe(
      'Tool: github_count({"state":"open"})',
    );

    // Clicking the [1] chip opens the tool row with the quote highlighted.
    fireEvent.click(container.querySelector('button.citation-chip[data-rank="1"]')!);
    expect(
      container.querySelector('article[data-card-id="tool_tr1"] mark.quote-highlight')?.textContent,
    ).toBe('32 open issues');
  });
});
