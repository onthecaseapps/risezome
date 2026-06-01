import type { ReactElement } from 'react';
import Link from 'next/link';
import { ChevronBackground } from '../_chevron-background';

/**
 * Easter egg: just the Risezome rising-chevron background, full-viewport.
 * Reached from the "Risezome" label on the What's-new card. `fixed inset-0`
 * lifts it over the whole app shell (sidebar included); clicking anywhere
 * returns to What's-new.
 */
export default function BackgroundEasterEggPage(): ReactElement {
  return (
    <Link
      href="/whats-new"
      aria-label="Back to What's new"
      className="fixed inset-0 z-50 block cursor-default"
    >
      <ChevronBackground />
    </Link>
  );
}
