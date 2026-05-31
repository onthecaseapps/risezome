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
      citations: [1],
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
      citations: [1],
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
});
