import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { SynthesisCard } from '../src/components/synthesis-card.js';
import type { CardEvent } from '../src/types.js';

function mkCard(over: Partial<CardEvent> = {}): CardEvent {
  return {
    cardId: 'src1',
    docId: 'd',
    source: 'github',
    type: 'issue',
    title: 'Source title',
    snippet: 'preview',
    body: 'full body content',
    score: 0.9,
    rank: 1,
    metadata: {},
    surfacedAt: 0,
    triggeredBy: 'window',
    traceId: 't',
    ...over,
  };
}

describe('SynthesisCard — phase: placeholder', () => {
  it('renders shimmer skeleton bars (not answer text, not cursor)', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[]}
      />,
    );
    expect(container.querySelector('.synthesis-skeleton')).not.toBeNull();
    expect(container.querySelectorAll('.synthesis-skeleton-bar').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('.synthesis-cursor')).toBeNull();
    expect(container.querySelector('.citations')).toBeNull();
    expect(container.querySelector('.synthesis-sources')).toBeNull();
  });

  it('skeleton bars are aria-hidden; outer article has aria-busy=true', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[]}
      />,
    );
    expect(container.querySelector('.synthesis-skeleton')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    // aria-live OFF during placeholder so SRs don't announce the shimmer.
    expect(container.querySelector('.synthesis-body')?.getAttribute('aria-live')).toBe('off');
  });

  it('shows source titles in a muted status line when sources are present', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[mkCard({ cardId: 'a', title: 'Alpha title' }), mkCard({ cardId: 'b', title: 'Beta title' })]}
      />,
    );
    const titleLine = container.querySelector('.synthesis-placeholder-sources');
    expect(titleLine).not.toBeNull();
    expect(titleLine?.textContent).toContain('Searching across 2 sources');
    expect(titleLine?.textContent).toContain('Alpha title');
    expect(titleLine?.textContent).toContain('Beta title');
  });

  it('omits source-title line entirely when sources is empty', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[]}
      />,
    );
    expect(container.querySelector('.synthesis-placeholder-sources')).toBeNull();
  });

  it('source-title singular vs plural copy', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[mkCard({ cardId: 'a', title: 'Only one' })]}
      />,
    );
    expect(container.querySelector('.synthesis-placeholder-sources')?.textContent).toContain(
      'Searching across 1 source',
    );
  });
});

describe('SynthesisCard — phase: streaming', () => {
  it('shows the typing cursor + the partial answer text; no citations row, no sources', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="streaming"
        answer={<>Partial answer </>}
        sources={[mkCard()]}
      />,
    );
    expect(container.querySelector('.synthesis-skeleton')).toBeNull();
    expect(container.querySelector('.synthesis-cursor')).not.toBeNull();
    expect(container.querySelector('.synthesis-body')?.textContent).toContain('Partial answer');
    expect(container.querySelector('.synthesis-sources')).toBeNull();
    expect(container.querySelector('.citations')).toBeNull();
  });

  it('sets aria-busy=true and aria-live=polite for streaming announce', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="streaming"
        answer={<>x</>}
        sources={[]}
      />,
    );
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.synthesis-body')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('SynthesisCard — pin button (U5)', () => {
  it('hides the pin button when no SynthesisActions are wired', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>x</>}
        sources={[]}
      />,
    );
    expect(container.querySelector('.pin-button')).toBeNull();
  });

  it('renders an unpinned glyph when pinned=false and pin action is wired', async () => {
    const { SynthesisActionsProvider } = await import('../src/state/synthesis-actions.js');
    const { container } = render(
      <SynthesisActionsProvider actions={{ pin: () => {} }}>
        <SynthesisCard
          synthesisId="s1"
          phase="done"
          answer={<>x</>}
          sources={[]}
          pinned={false}
        />
      </SynthesisActionsProvider>,
    );
    const btn = container.querySelector('.pin-button');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(btn?.getAttribute('aria-label')).toBe('Pin synthesis');
    // Regression: the unpinned glyph must render a visible (non-dimmed) icon —
    // an opacity<1 muted glyph read as an empty button ("pin doesn't show").
    const svg = btn?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('opacity')).toBeNull();
  });

  it('renders a pinned glyph when pinned=true and unpin action is wired', async () => {
    const { SynthesisActionsProvider } = await import('../src/state/synthesis-actions.js');
    const { container } = render(
      <SynthesisActionsProvider actions={{ unpin: () => {} }}>
        <SynthesisCard
          synthesisId="s1"
          phase="done"
          answer={<>x</>}
          sources={[]}
          pinned={true}
        />
      </SynthesisActionsProvider>,
    );
    const btn = container.querySelector('.pin-button');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-pressed')).toBe('true');
    expect(btn?.getAttribute('aria-label')).toBe('Unpin synthesis');
  });

  it('hides the pin button during placeholder + streaming phases', async () => {
    const { SynthesisActionsProvider } = await import('../src/state/synthesis-actions.js');
    const placeholder = render(
      <SynthesisActionsProvider actions={{ pin: () => {}, unpin: () => {} }}>
        <SynthesisCard
          synthesisId="s1"
          phase="placeholder"
          answer={null}
          sources={[]}
        />
      </SynthesisActionsProvider>,
    );
    expect(placeholder.container.querySelector('.pin-button')).toBeNull();
    placeholder.unmount();

    const streaming = render(
      <SynthesisActionsProvider actions={{ pin: () => {}, unpin: () => {} }}>
        <SynthesisCard
          synthesisId="s1"
          phase="streaming"
          answer={<>x</>}
          sources={[]}
        />
      </SynthesisActionsProvider>,
    );
    expect(streaming.container.querySelector('.pin-button')).toBeNull();
  });

  it('clicking pin fires the host action with synthesisId', async () => {
    const { SynthesisActionsProvider } = await import('../src/state/synthesis-actions.js');
    const { fireEvent } = await import('@testing-library/react');
    const { vi } = await import('vitest');
    const pin = vi.fn();
    const { container } = render(
      <SynthesisActionsProvider actions={{ pin }}>
        <SynthesisCard
          synthesisId="my-syn"
          phase="done"
          answer={<>x</>}
          sources={[]}
          pinned={false}
        />
      </SynthesisActionsProvider>,
    );
    fireEvent.click(container.querySelector('.pin-button')!);
    expect(pin).toHaveBeenCalledWith('my-syn');
  });
});

describe('SynthesisCard — phase: done', () => {
  it('hides cursor; renders the collapsed sources ledger; no trailing citations row', () => {
    const sources = [mkCard()];
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Final answer</>}
        sources={sources}
        citationRecords={[{ rank: 1, cardId: 'src1', position: 0 }]}
      />,
    );
    expect(container.querySelector('.synthesis-cursor')).toBeNull();
    // The ledger renders collapsed by default: header line present, no rows.
    const ledger = container.querySelector('.synthesis-ledger');
    expect(ledger).not.toBeNull();
    expect(ledger?.getAttribute('data-open')).toBe('false');
    expect(ledger?.textContent).toContain('Grounded in 1 cited source');
    expect(container.querySelector('.ledger-rows')).toBeNull();
    // The trailing consolidated citation-chip row was removed; inline chips
    // in the answer body are the only citation affordance now.
    expect(container.querySelector('.citations')).toBeNull();
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('false');
  });

  it('clicking the ledger header expands the rows; Expand all opens every passage', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Final answer</>}
        sources={[mkCard()]}
        citationRecords={[{ rank: 1, cardId: 'src1', position: 0 }]}
        additionalSources={[mkCard({ cardId: 'rel1', title: 'Related doc' })]}
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>('.ledger-toggle')!;
    fireEvent.click(toggle);
    const rows = container.querySelectorAll('.source-card-expanded');
    expect(rows).toHaveLength(2);
    // Cited row badge + related row label.
    expect(container.querySelector('.source-row-badge')?.textContent).toBe('1');
    expect([...container.querySelectorAll('.source-row-status')].map((s) => s.textContent)).toEqual([
      'Top match',
      'Related',
    ]);
    // Expand all passages opens both rows.
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-expand-all')!);
    expect(container.querySelectorAll('.source-card-expanded.is-open')).toHaveLength(2);
    expect(container.querySelector<HTMLButtonElement>('.ledger-expand-all')?.textContent).toBe(
      'Collapse all passages',
    );
  });

  it('header reads "grounded in N cited · M related" when related sources exist', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Final answer</>}
        sources={[mkCard()]}
        citationRecords={[{ rank: 1, cardId: 'src1', position: 0 }]}
        additionalSources={[
          mkCard({ cardId: 'rel1' }),
          mkCard({ cardId: 'rel2', source: 'confluence' }),
        ]}
      />,
    );
    expect(container.querySelector('.synthesis-grounded')?.textContent).toBe(
      'grounded in 1 cited · 2 related',
    );
    const ledger = container.querySelector('.synthesis-ledger');
    expect(ledger?.textContent).toContain('Grounded in 1 cited + 2 related sources');
    // Per-source dots: related dots render dimmed.
    expect(container.querySelectorAll('.ledger-dot')).toHaveLength(3);
    expect(container.querySelectorAll('.ledger-dot.is-related')).toHaveLength(2);
    // Collapsed line lists the distinct apps.
    expect(container.querySelector('.ledger-apps')?.textContent).toBe('· Github · Confluence');
  });
});

describe('SynthesisCard — B4 in-place transition (no remount)', () => {
  it('the same <article> element survives placeholder → streaming → done', () => {
    // The remount-vs-update distinction is what B4 cares about. We assert
    // it by checking that the <article> DOM node identity is preserved
    // across re-renders. A two-component branch (placeholder vs card)
    // would produce a fresh <article> on each phase change.
    const { container, rerender } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[]}
      />,
    );
    const articleAtPlaceholder = container.querySelector('article');
    expect(articleAtPlaceholder).not.toBeNull();

    rerender(
      <SynthesisCard
        synthesisId="s1"
        phase="streaming"
        answer={<>Streaming text</>}
        sources={[]}
      />,
    );
    const articleAtStreaming = container.querySelector('article');
    expect(articleAtStreaming).toBe(articleAtPlaceholder); // ref-identity check

    rerender(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Final text</>}
        sources={[]}
      />,
    );
    const articleAtDone = container.querySelector('article');
    expect(articleAtDone).toBe(articleAtPlaceholder);

    // Sanity: data-phase attribute updated across re-renders.
    expect(articleAtDone?.getAttribute('data-phase')).toBe('done');
  });

  it('the wrapping element classname encodes the current phase', () => {
    const { container, rerender } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="placeholder"
        answer={null}
        sources={[]}
      />,
    );
    expect(container.querySelector('article')?.classList.contains('synthesis-phase-placeholder')).toBe(true);
    rerender(
      <SynthesisCard
        synthesisId="s1"
        phase="streaming"
        answer={<>x</>}
        sources={[]}
      />,
    );
    expect(container.querySelector('article')?.classList.contains('synthesis-phase-streaming')).toBe(true);
  });
});

describe('SynthesisCard — related sources in the ledger (ALSO: line)', () => {
  it('renders RELATED rows for the additional sources when expanded; passage has the Open link', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Answer [1].</>}
        sources={[mkCard()]}
        citationRecords={[{ rank: 1, cardId: 'src1', position: 0 }]}
        additionalSources={[
          mkCard({ cardId: 'extra1', title: 'contextualize.ts', type: 'code', url: 'https://x/contextualize' }),
          mkCard({ cardId: 'extra2', title: 'file-chunker.ts', type: 'code', url: 'https://x/chunker' }),
        ]}
      />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    const related = [...container.querySelectorAll('.source-card-expanded.is-related')];
    expect(related).toHaveLength(2);
    expect(related.map((r) => r.querySelector('.source-row-title')?.textContent)).toEqual([
      'contextualize.ts',
      'file-chunker.ts',
    ]);
    // Opening a related row shows its passage with the source link.
    fireEvent.click(related[0]!.querySelector<HTMLButtonElement>('.source-card-toggle')!);
    expect(
      container.querySelector('.source-card-expanded.is-related .source-card-open')?.getAttribute('href'),
    ).toBe('https://x/contextualize');
  });

  it('a related card that is also cited renders once, as cited', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Answer [1].</>}
        sources={[mkCard()]}
        citationRecords={[{ rank: 1, cardId: 'src1', position: 0 }]}
        additionalSources={[mkCard()]}
      />,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>('.ledger-toggle')!);
    expect(container.querySelectorAll('.source-card-expanded')).toHaveLength(1);
    expect(container.querySelector('.source-card-expanded.is-related')).toBeNull();
  });

  it('ledger reads plain cited-only copy when there are no related sources', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Answer.</>}
        sources={[mkCard()]}
        citationRecords={[{ rank: 1, cardId: 'src1', position: 0 }]}
      />,
    );
    expect(container.querySelector('.synthesis-ledger')?.textContent).not.toContain('related');
    expect(container.querySelector('.synthesis-grounded')?.textContent).toBe('grounded in 1 cited');
  });

  it('ledger is absent while streaming even if marks already arrived', () => {
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="streaming"
        answer={<>Partial</>}
        sources={[]}
        additionalSources={[mkCard({ cardId: 'extra1' })]}
      />,
    );
    expect(container.querySelector('.synthesis-ledger')).toBeNull();
  });
});
