import type { ReactElement } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  CURRENT_ORG_COOKIE,
  CURRENT_TEAM_COOKIE,
  listUserOrgs,
  listUserTeams,
  requireAuthedUser,
} from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { Logo } from '../../_components/logo';
import { TeamSwitcher } from './team-switcher';
import { UserAvatarMenu } from './user-avatar-menu';

/**
 * Horizontal top bar shared across all `(authed)` routes.
 *   LEFT:  Risezome brand (logo + wordmark) + the "Org / #team" breadcrumb
 *          team-lens switcher.
 *   RIGHT: notifications bell (with an unread-gap dot) linking to /gaps,
 *          and the user-avatar dropdown.
 *
 * Async server component — resolves org + teams + the selected team lens from
 * the auth helpers + cookies (same pattern the old Sidebar used for orgs), and
 * re-evaluates the unread-notifications count on every render (the same
 * COUNT-only query relocated here from the sidebar). No "Share" action and no
 * "switch workspace" item (single org).
 *
 * Resolution does NOT enforce org membership (mirrors the layout's note): a
 * freshly-signed-in user on /onboarding has no org yet, so org/teams may be
 * empty — we render the brand alone and skip the switcher + count.
 */
export async function TopBar(): Promise<ReactElement> {
  const user = await requireAuthedUser();
  const orgs = await listUserOrgs();
  const cookieStore = await cookies();
  const orgCookie = cookieStore.get(CURRENT_ORG_COOKIE)?.value;
  const current = orgs.find((o) => o.id === orgCookie) ?? orgs[0] ?? null;

  const fullName = (user.user_metadata?.['full_name'] as string | undefined) ?? undefined;
  const email = user.email ?? '';

  let teams: Awaited<ReturnType<typeof listUserTeams>> = [];
  let currentTeamId: string | null = null;
  // Unread knowledge-gap notifications for the current user, scoped by RLS to
  // their own recipient rows. Drives the bell's pulsing dot — the same
  // COUNT-only pattern the sidebar used (no rows shipped). Relocated here.
  let unreadGapNotifications = 0;
  if (current !== null) {
    teams = await listUserTeams(current.id);
    const teamCookie = cookieStore.get(CURRENT_TEAM_COOKIE)?.value;
    currentTeamId =
      teamCookie !== undefined && teams.some((t) => t.id === teamCookie) ? teamCookie : null;

    const supabase = await createServerClient();
    const { count: notifCount } = await supabase
      .from('notifications')
      .select('notification_id', { count: 'exact', head: true })
      .eq('org_id', current.id)
      .is('read_at', null);
    unreadGapNotifications = notifCount ?? 0;
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link href="/upcoming" className="flex shrink-0 items-center gap-2.5" aria-label="Risezome home">
          <Logo size={26} className="shrink-0 text-accent" />
          <span className="text-base font-semibold tracking-tight">Risezome</span>
        </Link>
        {current !== null && (
          <>
            <span aria-hidden="true" className="text-border">
              |
            </span>
            <TeamSwitcher orgName={current.name} currentTeamId={currentTeamId} teams={teams} />
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          href="/gaps"
          aria-label={
            unreadGapNotifications > 0
              ? `Notifications (${unreadGapNotifications} unread)`
              : 'Notifications'
          }
          title="Notifications"
          className="relative rounded-md p-2 text-muted transition-colors hover:bg-accent-soft/50 hover:text-fg"
        >
          <BellIcon />
          {unreadGapNotifications > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-accent ring-2 ring-card"
            />
          )}
        </Link>
        <UserAvatarMenu email={email} fullName={fullName} />
      </div>
    </header>
  );
}

function BellIcon(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}
