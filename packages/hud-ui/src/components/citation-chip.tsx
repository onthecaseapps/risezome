'use client';

import { type ReactElement } from 'react';

/**
 * Inline citation pill rendered by SynthesisStream when an `[N]` or
 * `[N: "quote"]` token is detected in the streaming text.
 *
 * Behavioral evolution (plan U3):
 *
 *   Before: chip owned a `document.querySelector('article[data-card-id=…]')`
 *   + scrollIntoView + ephemeral `.is-cited-target` class. That model
 *   assumed sources lived in a sibling DOM region with stable IDs.
 *
 *   Now: chips are pure presentation + a callback. The parent
 *   `SynthesisCard` owns the expansion state (`{expandedSourceId,
 *   activeQuote}`) and provides `onActivate(rank, quote, cardId)`. The
 *   chip fires the callback on click; the parent re-renders the matching
 *   `<SourceCardExpanded>` with the new active quote, which in turn
 *   handles its own scrollIntoView on the highlighted `<mark>`.
 *
 * The callback shape (rank + quote + cardId) is the union of what the
 * parent needs to know. It can't derive `quote` from the chip's position
 * without re-walking the answer text, so the chip passes it along.
 *
 * Retracted source: when the parent's source list doesn't contain a card
 * matching `cardId` (source retracted between synthesis-done and click),
 * the parent's onActivate sees the missing source and signals back via
 * the chip's `data-source-retracted` attribute (set imperatively in the
 * onClick wrapper so CSS can style the inert state).
 *
 * Accessibility (S8): chips render as `<button type="button">` so they
 * sit in the keyboard tab order with native Enter/Space activation. When
 * a parent passes `disabled` (during placeholder phase / pre-completion
 * streaming), `aria-disabled` reflects it and the button skips tab order.
 */
export interface CitationChipProps {
  readonly rank: number;
  readonly cardId: string;
  readonly sourceTitle?: string | undefined;
  /** Verbatim quote for this citation occurrence. Undefined for bare
   *  `[N]` (parser fell back from misformatted output). */
  readonly quote?: string | undefined;
  /** Parent-supplied click handler. When omitted (e.g. SSR / preview),
   *  the chip is inert. */
  readonly onActivate?: (args: { rank: number; cardId: string; quote: string | undefined }) => void;
  /** Marks the chip inert (aria-disabled + click no-op). Used during
   *  streaming when the parser hasn't run yet. */
  readonly disabled?: boolean;
}

export function CitationChip({
  rank,
  cardId,
  sourceTitle,
  quote,
  onActivate,
  disabled = false,
}: CitationChipProps): ReactElement {
  function handleClick(): void {
    if (disabled) return;
    onActivate?.({ rank, cardId, quote });
  }

  return (
    <button
      type="button"
      className="citation-chip"
      data-rank={rank}
      data-card-id={cardId}
      title={sourceTitle ?? `Source ${String(rank)}`}
      aria-disabled={disabled ? 'true' : undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={handleClick}
    >
      {rank}
    </button>
  );
}
