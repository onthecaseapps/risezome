import type { ReactElement } from 'react';

/**
 * Screen-reader-only live region. The streaming synthesis card is
 * `aria-live="off"` so per-token DOM mutations don't spam announcements;
 * this sibling element receives the finalized text exactly once on
 * synthesisDone so screen readers announce the whole answer.
 *
 * Mirrors `#synthesis-announce` in apps/hud/index.html.
 */
export function SynthesisAnnounce({ text }: { text: string | null }): ReactElement {
  return (
    <div id="synthesis-announce" aria-live="polite" className="sr-only">
      {text ?? ''}
    </div>
  );
}
