'use client';

import { useRef, type ReactElement } from 'react';

/**
 * Inline citation pill rendered by SynthesisStream when an `[N]` token is
 * detected in the streaming text.
 *
 * **NET-NEW component, not copied from the demo.** The landing-page demo
 * renders citations as inert `<span>[N]</span>`. This component implements
 * the polish-plan U5 contract:
 *
 * - `<button type="button">` so the chip is in the keyboard tab order with
 *   native Enter/Space activation and screen-reader role.
 * - `title` set to the source card's title (hover preview).
 * - Click handler resolves `article[data-card-id="…"]`, scrollIntoView with
 *   smooth/center, and adds `.is-cited-target` for 700ms so the eye finds
 *   the destination even when the target was already in view.
 * - When the target is missing (source retracted before chip was clicked),
 *   sets `data-source-retracted="true"` and updates `title` to "Source no
 *   longer available". The retracted state is visible via CSS so the user
 *   sees the click as a deliberate no-op, not a broken UI.
 * - `:focus-visible` ring is handled in styles.css.
 *
 * Selector uses `article[data-card-id="…"]` — scoped to articles so the
 * chip's own data-card-id (it does not carry one — `data-card-id` on the
 * chip lives on the button) is not accidentally matched.
 */
export function CitationChip({
  rank,
  cardId,
  sourceTitle,
}: {
  rank: number;
  cardId: string;
  sourceTitle: string | undefined;
}): ReactElement {
  const btnRef = useRef<HTMLButtonElement | null>(null);

  function onClick(): void {
    const btn = btnRef.current;
    if (btn === null) return;
    const target = document.querySelector<HTMLElement>(`article[data-card-id="${cardId}"]`);
    if (target === null) {
      btn.dataset['sourceRetracted'] = 'true';
      btn.title = 'Source no longer available';
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('is-cited-target');
    window.setTimeout(() => target.classList.remove('is-cited-target'), 700);
  }

  return (
    <button
      ref={btnRef}
      type="button"
      className="citation-chip"
      data-rank={rank}
      data-card-id={cardId}
      title={sourceTitle ?? `Source ${rank}`}
      onClick={onClick}
    >
      [{rank}]
    </button>
  );
}
