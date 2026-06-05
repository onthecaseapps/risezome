import type { ReactElement, ReactNode } from 'react';
import { Sidebar } from './_components/sidebar';
import { TopBar } from './_components/top-bar';

/**
 * Layout shared across all `(authed)` routes. The nav rail (Risezome brand at
 * the top, nav icons, collapse toggle) runs full-height down the left; to its
 * right, a column with the top bar ("Org / #team" team-switcher on the left;
 * notifications bell + user-avatar menu on the right) above the scrolling main
 * content area.
 *
 * Per the U3 design note: this layout does NOT enforce org membership itself —
 * the TopBar / Sidebar data fetch requires only a session. Onboarding lives
 * inside this layout but its purpose is to create the user's first org; if we
 * enforced org-membership here we'd infinite-loop. Page-level
 * requireAuthedUserWithOrg() is the gate for routes that need an org context
 * (sources, meetings, settings, etc.).
 */
export default function AuthedLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* @ts-expect-error - Async Server Component child. Next 16 + React 19
            handle this correctly; the @types/react lib hasn't caught up to
            async JSX in all positions yet. Remove once it does. */}
        <TopBar />
        {/* Lock the shell to the viewport and scroll only the main column, so
            the top bar + rail stay pinned while long content (a capture's card
            list, a meeting review) scrolls independently instead of the whole
            document. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
