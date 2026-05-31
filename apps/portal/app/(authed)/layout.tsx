import type { ReactElement, ReactNode } from 'react';
import { AppHeader } from './_components/app-header';

/**
 * Layout shared across all `(authed)` routes. Verifies session (via
 * AppHeader's data fetch) and renders the topbar + page body.
 *
 * Per the U3 design note: this layout does NOT enforce org membership.
 * The onboarding page lives inside this layout but its purpose is to
 * create the user's first org; if we enforced org-membership here, we'd
 * infinite-loop. Page-level requireAuthedUserWithOrg() is the gate for
 * routes that need an org context (sources, meetings, settings, etc.).
 */
export default function AuthedLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      {/* @ts-expect-error - Async Server Component child. Next 16 + React 19
          handles this correctly; the TS lib hasn't caught up to async JSX in
          all positions yet. Remove once @types/react ships async-JSX support. */}
      <AppHeader />
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </div>
  );
}
