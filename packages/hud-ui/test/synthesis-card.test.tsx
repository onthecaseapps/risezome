import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
          citations={[]}
          sources={[]}
          pinned={false}
        />
      </SynthesisActionsProvider>,
    );
    const btn = container.querySelector('.pin-button');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(btn?.getAttribute('aria-label')).toBe('Pin synthesis');
  });

  it('renders a pinned glyph when pinned=true and unpin action is wired', async () => {
    const { SynthesisActionsProvider } = await import('../src/state/synthesis-actions.js');
    const { container } = render(
      <SynthesisActionsProvider actions={{ unpin: () => {} }}>
        <SynthesisCard
          synthesisId="s1"
          phase="done"
          answer={<>x</>}
          citations={[]}
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
          citations={[]}
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
          citations={[]}
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
          citations={[]}
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
  it('hides cursor; renders citations + sources', () => {
    const sources = [mkCard()];
    const { container } = render(
      <SynthesisCard
        synthesisId="s1"
        phase="done"
        answer={<>Final answer</>}
        citations={[<span key="c1" data-testid="chip" />]}
        sources={sources}
      />,
    );
    expect(container.querySelector('.synthesis-cursor')).toBeNull();
    expect(container.querySelector('.synthesis-sources')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="chip"]').length).toBe(1);
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('false');
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
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
        citations={[]}
        sources={[]}
      />,
    );
    expect(container.querySelector('article')?.classList.contains('synthesis-phase-placeholder')).toBe(true);
    rerender(
      <SynthesisCard
        synthesisId="s1"
        phase="streaming"
        answer={<>x</>}
        citations={[]}
        sources={[]}
      />,
    );
    expect(container.querySelector('article')?.classList.contains('synthesis-phase-streaming')).toBe(true);
  });
});
