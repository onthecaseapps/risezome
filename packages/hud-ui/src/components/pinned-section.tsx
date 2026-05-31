'use client';

import { type ReactElement } from 'react';
import { useAppState } from '../state/app-state';
import { HudCard } from './hud-card';

/**
 * Top-of-HUD section housing user-pinned cards. Cards stay here until
 * un-pinned, at which point they rejoin the main `<CardStream>`. Insertion
 * order = the order the user pinned them.
 *
 * The `pinned` CSS class added below is the same one the production HUD
 * uses for visual styling of pinned cards.
 */
export function PinnedSection(): ReactElement {
  const state = useAppState();
  const pinned = Array.from(state.cards.values()).filter((c) => c.pinned);

  return (
    <section id="pinned-section" aria-label="Pinned cards" className="pinned-section">
      {pinned.map((rec) => (
        <HudCard key={rec.card.cardId} card={rec.card} pinned />
      ))}
    </section>
  );
}
