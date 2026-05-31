import type { ReactElement } from 'react';
import { Logo } from '../../_components/logo';
import { CURRENT_ORG_COOKIE, listUserOrgs, requireAuthedUser } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { cookies } from 'next/headers';
import { OrgSwitcher } from './org-switcher';
import { SidebarNavLink } from './sidebar-nav-link';
import { CalendarIcon, CapturesIcon, LiveIcon, SettingsIcon, SourcesIcon } from './nav-icons';
import { UserCard } from './user-card';

/**
 * Left sidebar shared across all `(authed)` routes. Top→bottom:
 *   1. Logo + Risezome wordmark
 *   2. Current-org chip with built-in switcher (none if user hasn't onboarded)
 *   3. Nav: Upcoming, Live meeting (dynamic), Sources, Captures, Settings
 *      — Live meeting smart-links to the currently-recording meeting in
 *        the user's current org when one exists, with a pulsing red dot;
 *        otherwise it stays disabled.
 *   4. UserCard at the bottom with avatar + email + sign-out
 *
 * Server component: re-evaluates the active-meeting lookup on every
 * render. Cheap query: indexed (org_id, status) on meetings.
 */
export async function Sidebar(): Promise<ReactElement> {
  const user = await requireAuthedUser();
  const orgs = await listUserOrgs();
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const current = orgs.find((o) => o.id === cookieValue) ?? orgs[0] ?? null;

  const fullName = (user.user_metadata?.['full_name'] as string | undefined) ?? undefined;
  const email = user.email ?? '';

  // Find the most-recent recording meeting in the current org. RLS
  // scopes to org members so users only see their org's live meeting.
  let activeMeetingId: string | null = null;
  if (current !== null) {
    const supabase = await createServerClient();
    const { data: live } = await supabase
      .from('meetings')
      .select('meeting_id')
      .eq('org_id', current.id)
      .eq('status', 'recording')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (live !== null) activeMeetingId = live.meeting_id as string;
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
          href={activeMeetingId !== null ? `/meetings/${activeMeetingId}/live` : '/meetings/live'}
          matchPrefix="/meetings/"
          icon={<LiveIcon />}
          label="Live meeting"
          disabled={activeMeetingId === null}
          {...(activeMeetingId !== null
            ? {
                dot: (
                  <span
                    aria-label="Recording"
                    className="inline-block h-2 w-2 animate-pulse rounded-full bg-rose-400"
                  />
                ),
              }
            : {})}
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
        />
        <SidebarNavLink
          href="/settings"
          matchPrefix="/settings"
          icon={<SettingsIcon />}
          label="Settings"
        />
      </nav>

      <UserCard email={email} fullName={fullName} />
    </aside>
  );
}
