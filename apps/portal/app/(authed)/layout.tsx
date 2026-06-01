import type { ReactElement, ReactNode } from 'react';
import { Sidebar } from './_components/sidebar';

/**
 * Layout shared across all `(authed)` routes. Sidebar on the left
 * (Risezome wordmark + org switcher + nav + user card), main content
 * area on the right.
 *
 * Per the U3 design note: this layout does NOT enforce org membership
 * itself — the Sidebar's data fetch requires only a session. Onboarding
 * lives inside this layout but its purpose is to create the user's first
 * org; if we enforced org-membership here we'd infinite-loop. Page-level
 * requireAuthedUserWithOrg() is the gate for routes that need an org
 * context (sources, meetings, settings, etc.).
 *
 * Mobile responsive: the sidebar collapses to a top-bar on narrow
 * viewports (deferred — landed as plain side-by-side for MVP).
 */
export default function AuthedLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      {/* @ts-expect-error - Async Server Component child. Next 16 + React 19
          handle this correctly; the @types/react lib hasn't caught up to
          async JSX in all positions yet. Remove once it does. */}
      <Sidebar />
      {/* Lock the shell to the viewport and scroll only the main column,
          so the sidebar stays pinned while long content (a capture's
          card list, a meeting review) scrolls independently instead of
          the whole document. */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
    </div>
  );
}
