import type { ReactElement } from 'react';
import { listUserOrgs, requireAuthedUser, CURRENT_ORG_COOKIE } from '../../_lib/auth';
import { cookies } from 'next/headers';
import { OrgSwitcher } from './org-switcher';

/**
 * Top bar shown across all authed routes. Renders:
 *   - Risezome wordmark / app link
 *   - Org switcher (omitted when user has no orgs — onboarding state)
 *   - Sign-out form (POST to /api/auth/sign-out)
 *
 * Server component: reads orgs + cookie on the server, hydrates the
 * OrgSwitcher client component with the data already shaped.
 */
export async function AppHeader(): Promise<ReactElement> {
  const user = await requireAuthedUser();
  const orgs = await listUserOrgs();
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const current = orgs.find((o) => o.id === cookieValue) ?? orgs[0] ?? null;

  return (
    <header className="border-b border-[var(--border)] bg-[var(--bg)]">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-between px-4">
        <a href="/sources" className="font-semibold tracking-tight">
          Risezome
        </a>
        <div className="flex items-center gap-3">
          {current !== null && (
            <OrgSwitcher
              currentOrgId={current.id}
              currentOrgName={current.name}
              orgs={orgs}
            />
          )}
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-3 py-1.5 text-sm hover:border-[var(--accent)]"
              title={`Signed in as ${user.email ?? user.id}`}
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
