'use client';

import { type ReactElement } from 'react';
import { useAppState } from '../state/app-state';
import { HudCard } from './hud-card';
import { EmptyState } from './empty-state';

/**
 * Newest-first stream of un-pinned cards. Pinned cards are rendered by
 * `<PinnedSection>` above the stream; consolidated cards live inside their
 * synthesis card (rendered by `<SynthesisStream>`).
 *
 * `is-entering` animation is applied on mount via the polish-plan U1
 * pattern: card has the class on first paint, removed after 400ms via
 * setTimeout. In the new HUD this lives on `HudCard` directly through
 * its `entering` prop, set true for the first render-cycle of a card.
 *
 * Reverse-iteration mirrors the production HUD's `insertBefore(el,
 * firstChild)` semantics — most recent card on top.
 */
export function CardStream(): ReactElement {
  const state = useAppState();
  const unpinned = Array.from(state.cards.values()).filter((c) => !c.pinned);
  const reversed = unpinned.slice().reverse();

  if (reversed.length === 0 && state.syntheses.size === 0) {
    return (
      <section
        id="card-stream"
        aria-label="Card stream"
        aria-live="polite"
        className="card-stream"
      >
        <EmptyState />
      </section>
    );
  }

  return (
    <section
      id="card-stream"
      aria-label="Card stream"
      aria-live="polite"
      className="card-stream"
    >
      {reversed.map((rec) => (
        <HudCard key={rec.card.cardId} card={rec.card} />
      ))}
    </section>
  );
}
