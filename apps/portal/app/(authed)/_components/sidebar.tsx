import type { ReactElement } from 'react';
import { Logo } from '../../_components/logo';
import { CURRENT_ORG_COOKIE, listUserOrgs, requireAuthedUser } from '../../_lib/auth';
import { cookies } from 'next/headers';
import { OrgSwitcher } from './org-switcher';
import { SidebarNavLink } from './sidebar-nav-link';
import { CalendarIcon, CapturesIcon, LiveIcon, SourcesIcon } from './nav-icons';
import { UserCard } from './user-card';

/**
 * Left sidebar shared across all `(authed)` routes. Top→bottom:
 *   1. Logo + Risezome wordmark
 *   2. Current-org chip with built-in switcher (none if user hasn't onboarded)
 *   3. Nav: Upcoming, Live meeting, Sources, Captures
 *      — Upcoming/Live/Captures are disabled until their pages ship (U7/U11/U12);
 *      they render greyed-out so the sidebar shape is complete and the
 *      forthcoming surfaces are visible to the user
 *   4. UserCard at the bottom with avatar + email + sign-out
 *
 * Server component: reads user + orgs + cookie on the server, hydrates the
 * OrgSwitcher client component with the data already shaped.
 */
export async function Sidebar(): Promise<ReactElement> {
  const user = await requireAuthedUser();
  const orgs = await listUserOrgs();
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const current = orgs.find((o) => o.id === cookieValue) ?? orgs[0] ?? null;

  const fullName = (user.user_metadata?.['full_name'] as string | undefined) ?? undefined;
  const email = user.email ?? '';

  return (
    <aside className="flex h-dvh w-60 shrink-0 flex-col border-r border-border bg-card">
      {/* Brand */}
      <div className="px-4 pb-3 pt-5">
        <div className="flex items-center gap-2.5">
          <Logo size={28} className="text-accent" />
          <span className="text-base font-semibold tracking-tight">Risezome</span>
        </div>
        {current !== null && (
          <div className="mt-3">
            <OrgSwitcher
              currentOrgId={current.id}
              currentOrgName={current.name}
              orgs={orgs}
            />
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 px-3 py-4">
        <SidebarNavLink
          href="/upcoming"
          matchPrefix="/upcoming"
          icon={<CalendarIcon />}
          label="Upcoming"
        />
        <SidebarNavLink
          href="/meetings/live"
          matchPrefix="/meetings/live"
          icon={<LiveIcon />}
          label="Live meeting"
          disabled
        />
        <SidebarNavLink
          href="/sources"
          matchPrefix="/sources"
          icon={<SourcesIcon />}
          label="Sources"
        />
        <SidebarNavLink
          href="/captures"
          matchPrefix="/captures"
          icon={<CapturesIcon />}
          label="Captures"
          disabled
        />
      </nav>

      <UserCard email={email} fullName={fullName} />
    </aside>
  );
}
