import type { ReactElement } from 'react';
import { CURRENT_ORG_COOKIE, listUserOrgs } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { cookies } from 'next/headers';
import { SidebarFrame } from './sidebar-frame';
import { SidebarNavLink } from './sidebar-nav-link';
import { CalendarIcon, CapturesIcon, DebugIcon, GapsIcon, LiveIcon, SettingsIcon, SourcesIcon } from './nav-icons';

/**
 * Left nav icon rail shared across all `(authed)` routes. The brand, team
 * switcher, notifications bell, and user menu now live in the top bar (U6); the
 * rail holds only the nav links:
 *   Upcoming, Live meeting (dynamic), Captures, Knowledge gaps,
 *   Sources / Settings (managers only), dev links. ("What's new" moved to the
 *   user-avatar menu — it's product news, not primary nav.)
 *
 * "Live meeting" always routes to /meetings/live (the list page). A pulsing red
 * dot appears over its icon when one or more meetings are currently recording in
 * the user's current org; the link is disabled only when there are zero active.
 * Counting beats smart-linking to a single meeting because a team often has
 * multiple concurrent meetings — picking one would be wrong half the time.
 *
 * Server component: re-evaluates the active count on every render. Cheap query:
 * indexed (org_id, status) on meetings, COUNT-only.
 */
export async function Sidebar(): Promise<ReactElement> {
  const orgs = await listUserOrgs();
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const current = orgs.find((o) => o.id === cookieValue) ?? orgs[0] ?? null;
  // Manager-only surfaces (Sources, Settings, Members) are hidden for members.
  // Nav hiding is UX only — the pages themselves enforce requireManager().
  // Admin-power nav (Teams, Sources, Members, Settings) shows for the Admin tier:
  // a stored `manager` OR a `super_admin` (who inherits all admin powers). Gating on
  // 'manager' alone would hide these from a super_admin — e.g. the org owner/master
  // key. Nav hiding is UX only; the pages enforce requireAdmin().
  const isManager = current?.role === 'manager' || current?.role === 'super_admin';

  // Count recording meetings in the current org. RLS scopes to org
  // members so users only see their org's count. HEAD + count avoids
  // shipping rows we don't need; the list page does the full select.
  // Mirrors the 6h freshness window in /meetings/live so the rail dot
  // and the list contents never disagree — a stuck meeting whose
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
    <SidebarFrame
      nav={
        <>
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
        <SidebarNavLink
          href="/gaps"
          matchPrefix="/gaps"
          icon={<GapsIcon />}
          label="Knowledge gaps"
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
              href="/settings"
              matchPrefix="/settings"
              icon={<SettingsIcon />}
              label="Settings"
            />
          </>
        )}

        {/* Dev-only Debug section. Hidden in production builds so
         *  internal-only surfaces (live-mic, /ask retrieval probe)
         *  don't ship to end users. NODE_ENV is set by Next.js based
         *  on `next dev` vs `next build` — no separate flag needed. */}
        {process.env.NODE_ENV === 'development' && (
          <>
            <div className="mt-4 px-3 pb-1 text-[10px] uppercase tracking-wider text-muted group-data-[collapsed=true]/sb:hidden">
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
            <SidebarNavLink
              href="/debug/eval"
              matchPrefix="/debug/eval"
              icon={<DebugIcon />}
              label="Corpus eval"
            />
          </>
        )}
        </>
      }
    />
  );
}
