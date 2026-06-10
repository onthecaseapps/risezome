import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { SyncStatus } from './_sync-status';
import { lookupMeetingsForEvents } from './_meetings-lookup';
import { LiveStatusProvider } from './_live-status';
import { DayGroups, HeaderSubtitle, type CalendarEventRow } from './_day-groups';
import { primaryButtonClass } from '../_components/ui';

/**
 * Upcoming meetings for the current org. Shows the next 7 days of
 * calendar events synced from Google (U6b's sync-calendar function).
 *
 * Each row:
 *   - title (linked to Google Calendar if htmlLink is available)
 *   - time range
 *   - platform badge (zoom/meet/other) + conference URL link
 *   - opt-in toggle (enabled for zoom/meet only)
 *
 * The server component owns the data fetch and passes a FLAT, start_at-sorted
 * event list down; the day grouping, "Today"/"Tomorrow" headers, time labels,
 * and the "N today" count all live in the _day-groups client components — day
 * boundaries and clock labels depend on the VIEWER's timezone, which the
 * server doesn't know (rendering them here used the server's zone).
 *
 * Empty states:
 *   - User has no Google token → "Reconnect Google" prompt
 *     (handled separately by the auth flow; here we just show the
 *     no-events empty state with a hint)
 *   - User has a token but no events in window → "No meetings in the
 *     next 7 days" + Sync now CTA
 *
 * Polling: not needed — the cron syncs every 5 min and the user can
 * trigger Sync now manually. We could add polling for an in-flight
 * sync but the UX is better served by the explicit button + a
 * page-reload after.
 */
export default async function UpcomingPage(): Promise<ReactElement> {
  const { user, orgId, orgName } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Filter on `end_at >= now` so in-progress meetings (start_at < now <
  // end_at) stay visible — otherwise a meeting disappears the moment it
  // starts, and the user loses the row they need to (a) click into the
  // live view, (b) toggle the bot off, or (c) retry a failed launch.
  // `lte('start_at', horizon)` keeps the 7-day forward window.
  const { data: rows, error } = await supabase
    .from('calendar_events')
    .select(
      'id, user_id, event_id, title, start_at, end_at, conference_url, platform, attendee_count, is_organizer, bot_optin',
    )
    .eq('org_id', orgId)
    .gte('end_at', now.toISOString())
    .lte('start_at', horizon.toISOString())
    .order('start_at', { ascending: true });

  const events = (rows ?? []) as CalendarEventRow[];
  const meetingsByEventId = await lookupMeetingsForEvents(orgId, events.map((e) => e.id));
  const lastSyncedAt = await lookupLastSyncedAt(user.id);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Upcoming meetings</h1>
          <HeaderSubtitle startAtIsos={events.map((e) => e.start_at)} orgName={orgName} />
        </div>
        <div className="flex items-center gap-4">
          <SyncStatus lastSyncedAtIso={lastSyncedAt} />
          <a
            href="https://calendar.google.com/calendar/u/0/r/eventedit"
            target="_blank"
            rel="noopener noreferrer"
            className={primaryButtonClass}
          >
            <PlusIcon />
            Add meeting
          </a>
        </div>
      </header>

      {error !== null ? (
        <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          Failed to load calendar: {error.message}
        </div>
      ) : events.length === 0 ? (
        <EmptyState />
      ) : (
        <LiveStatusProvider
          eventIds={events.map((e) => e.id)}
          initial={Object.fromEntries(meetingsByEventId)}
        >
          <DayGroups events={events} currentUserId={user.id} />
          <p className="mt-8 text-center text-xs text-muted">
            Risezome joins only the meetings with the bot toggled on. Toggle off to skip one.
          </p>
        </LiveStatusProvider>
      )}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center shadow-[var(--card-shadow)]">
      <h2 className="text-xl font-semibold tracking-tight">All quiet today</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
        Nothing on the calendar in the next 7 days. Add one or make sure your sources are
        connected so Risezome has context when meetings do show up.
      </p>
      <div className="mt-6 flex items-center justify-center gap-2">
        <a
          href="https://calendar.google.com/calendar/u/0/r/eventedit"
          target="_blank"
          rel="noopener noreferrer"
          className={primaryButtonClass}
        >
          Add meeting
        </a>
        <a
          href="/sources"
          className="inline-flex items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-fg hover:bg-accent-soft"
        >
          Check sources
        </a>
      </div>
    </div>
  );
}

function PlusIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * Last calendar-sync timestamp for this user. We use the most recent
 * `updated_at` on the user's calendar_events rows; if there are none,
 * fall back to the user_google_tokens row (bumped by the token refresh
 * inside the sync function). Returns null if neither exists.
 */
async function lookupLastSyncedAt(userId: string): Promise<string | null> {
  const service = createServiceRoleClient();
  const { data: ev } = await service
    .from('calendar_events')
    .select('updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ev !== null) return ev.updated_at as string;

  const { data: token } = await service
    .from('user_google_tokens')
    .select('updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  return (token?.updated_at as string | undefined) ?? null;
}
