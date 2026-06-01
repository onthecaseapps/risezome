import type { ReactElement } from 'react';
import { Logo } from '../../_components/logo';
import { CURRENT_ORG_COOKIE, listUserOrgs, requireAuthedUser } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { cookies } from 'next/headers';
import { OrgSwitcher } from './org-switcher';
import { SidebarNavLink } from './sidebar-nav-link';
import { CalendarIcon, CapturesIcon, DebugIcon, LiveIcon, MembersIcon, SettingsIcon, SourcesIcon, WhatsNewIcon } from './nav-icons';
import { UserCard } from './user-card';

/**
 * Left sidebar shared across all `(authed)` routes. Top→bottom:
 *   1. Logo + Risezome wordmark
 *   2. Current-org chip with built-in switcher (none if user hasn't onboarded)
 *   3. Nav: Upcoming, Live meeting (dynamic), Captures, Sources, Settings
 *      — Live meeting always routes to /meetings/live (the list page).
 *        A pulsing red dot appears next to the label when one or more
 *        meetings are currently recording in the user's current org;
 *        the link is disabled only when there are zero active.
 *        Counting beats smart-linking to a single meeting because a
 *        team often has multiple concurrent meetings — picking one
 *        would be wrong half the time.
 *   4. UserCard at the bottom with avatar + email + sign-out
 *
 * Server component: re-evaluates the active count on every render.
 * Cheap query: indexed (org_id, status) on meetings, COUNT-only.
 */
export async function Sidebar(): Promise<ReactElement> {
  const user = await requireAuthedUser();
  const orgs = await listUserOrgs();
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const current = orgs.find((o) => o.id === cookieValue) ?? orgs[0] ?? null;
  // Manager-only surfaces (Sources, Settings, Members) are hidden for members.
  // Nav hiding is UX only — the pages themselves enforce requireManager().
  const isManager = current?.role === 'manager';

  const fullName = (user.user_metadata?.['full_name'] as string | undefined) ?? undefined;
  const email = user.email ?? '';

  // Count recording meetings in the current org. RLS scopes to org
  // members so users only see their org's count. HEAD + count avoids
  // shipping rows we don't need; the list page does the full select.
  // Mirrors the 6h freshness window in /meetings/live so the sidebar
  // dot and the list contents never disagree — a stuck meeting whose
  // started_at is older than 6h won't surface in either place.
  let activeMeetingCount = 0;
  if (current !== null) {
    const supabase = await createServerClient();
    const freshnessCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('meetings')
      .select('meeting_id', { count: 'exact', head: true })
      .eq('org_id', current.id)
      .eq('status', 'recording')
      .gte('started_at', freshnessCutoff);
    activeMeetingCount = count ?? 0;
  }

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
          matchPrefix="/meetings/"
          icon={<LiveIcon />}
          label={activeMeetingCount > 1 ? `Live meetings (${activeMeetingCount})` : 'Live meeting'}
          disabled={activeMeetingCount === 0}
          {...(activeMeetingCount > 0
            ? {
                dot: (
                  <span
                    aria-label={`${activeMeetingCount} recording`}
                    className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-400"
                  />
                ),
              }
            : {})}
        />
        <SidebarNavLink
          href="/captures"
          matchPrefix="/captures"
          icon={<CapturesIcon />}
          label="Captures"
        />
        {isManager && (
          <>
            <SidebarNavLink
              href="/sources"
              matchPrefix="/sources"
              icon={<SourcesIcon />}
              label="Sources"
            />
            <SidebarNavLink
              href="/members"
              matchPrefix="/members"
              icon={<MembersIcon />}
              label="Members"
            />
            <SidebarNavLink
              href="/settings"
              matchPrefix="/settings"
              icon={<SettingsIcon />}
              label="Settings"
            />
          </>
        )}
        <SidebarNavLink
          href="/whats-new"
          matchPrefix="/whats-new"
          icon={<WhatsNewIcon />}
          label="What's new"
        />

        {/* Dev-only Debug section. Hidden in production builds so
         *  internal-only surfaces (live-mic, /ask retrieval probe)
         *  don't ship to end users. NODE_ENV is set by Next.js based
         *  on `next dev` vs `next build` — no separate flag needed. */}
        {process.env.NODE_ENV === 'development' && (
          <>
            <div className="mt-4 px-3 pb-1 text-[10px] uppercase tracking-wider text-muted">
              Dev
            </div>
            <SidebarNavLink
              href="/debug/live-mic"
              matchPrefix="/debug/live-mic"
              icon={<DebugIcon />}
              label="Live-mic debug"
            />
            <SidebarNavLink
              href="/debug/ask"
              matchPrefix="/debug/ask"
              icon={<DebugIcon />}
              label="Retrieval probe"
            />
          </>
        )}
      </nav>

      <UserCard email={email} fullName={fullName} />
    </aside>
  );
}
