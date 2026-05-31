import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { OptInToggle } from './_opt-in-toggle';
import { SyncStatus } from './_sync-status';

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

interface CalendarEventRow {
  id: string;
  user_id: string;
  event_id: string;
  title: string;
  start_at: string;
  end_at: string;
  conference_url: string | null;
  platform: 'zoom' | 'meet' | 'other' | null;
  attendee_count: number;
  is_organizer: boolean;
  bot_optin: boolean;
}

export default async function UpcomingPage(): Promise<ReactElement> {
  const { user, orgId, orgName } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const { data: rows, error } = await supabase
    .from('calendar_events')
    .select(
      'id, user_id, event_id, title, start_at, end_at, conference_url, platform, attendee_count, is_organizer, bot_optin',
    )
    .eq('org_id', orgId)
    .gte('start_at', now.toISOString())
    .lte('start_at', horizon.toISOString())
    .order('start_at', { ascending: true });

  const events = (rows ?? []) as CalendarEventRow[];
  const grouped = groupByDay(events);
  const todayCount = countToday(events);
  const lastSyncedAt = await lookupLastSyncedAt(user.id);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Upcoming meetings</h1>
          <p className="mt-1.5 text-sm text-muted">
            {formatHeaderDate()} {todayCount > 0 ? `· ${todayCount} today` : '· no meetings today'}
            <span className="ml-1 text-muted/70">· {orgName}</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          <SyncStatus lastSyncedAtIso={lastSyncedAt} />
          <a
            href="https://calendar.google.com/calendar/u/0/r/eventedit"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-press"
          >
            <PlusIcon />
            Add meeting
          </a>
        </div>
      </header>

      {error !== null ? (
        <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          Failed to load calendar: {error.message}
        </div>
      ) : events.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="flex flex-col gap-6">
            {grouped.map((group) => (
              <DayGroup key={group.dayKey} day={group.day} events={group.events} currentUserId={user.id} />
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-muted">
            Risezome joins only the meetings with the bot toggled on. Toggle off to skip one.
          </p>
        </>
      )}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
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
          className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-press"
        >
          Schedule a meeting
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

function DayGroup({
  day,
  events,
  currentUserId,
}: {
  day: string;
  events: CalendarEventRow[];
  currentUserId: string;
}): ReactElement {
  return (
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">{day}</h2>
      <ul className="flex flex-col gap-2">
        {events.map((e) => (
          <li key={e.id}>
            <EventRow event={e} currentUserId={currentUserId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventRow({
  event,
  currentUserId,
}: {
  event: CalendarEventRow;
  currentUserId: string;
}): ReactElement {
  const owned = event.user_id === currentUserId;
  const status = describeStatus(event.start_at, event.end_at);
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex w-14 flex-shrink-0 flex-col items-end text-xs text-muted">
        <span className="text-sm font-medium text-fg">{formatTime(event.start_at)}</span>
        <span>{formatTime(event.end_at)}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{event.title || '(untitled)'}</span>
          <PlatformBadge platform={event.platform} />
          {event.is_organizer ? (
            <span className="rounded-full bg-bg/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
              Organizer
            </span>
          ) : null}
          <StatusChip status={status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          {event.conference_url !== null ? (
            <a
              href={event.conference_url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate text-accent hover:underline"
            >
              {prettyUrl(event.conference_url)}
            </a>
          ) : (
            <span className="italic">No conference link</span>
          )}
          {event.attendee_count > 0 ? <span>· {event.attendee_count} attendees</span> : null}
        </div>
      </div>

      {owned ? (
        <OptInToggle eventId={event.id} initial={event.bot_optin} platform={event.platform} />
      ) : (
        <div className="text-right text-[11px] text-muted">
          Owned by teammate
          {event.bot_optin ? <div className="mt-0.5 text-accent">Risezome joining</div> : null}
        </div>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: { label: string; tone: 'live' | 'soon' | 'later' } | null }): ReactElement | null {
  if (status === null) return null;
  const toneClass =
    status.tone === 'live'
      ? 'bg-emerald-500/15 text-emerald-300'
      : status.tone === 'soon'
      ? 'bg-accent-soft text-accent'
      : 'bg-bg/60 text-muted';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${toneClass}`}>
      {status.label}
    </span>
  );
}

function PlusIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PlatformBadge({ platform }: { platform: 'zoom' | 'meet' | 'other' | null }): ReactElement | null {
  if (platform === null) return null;
  const map: Record<NonNullable<typeof platform>, { label: string; className: string }> = {
    zoom: { label: 'Zoom', className: 'bg-blue-500/15 text-blue-300' },
    meet: { label: 'Meet', className: 'bg-emerald-500/15 text-emerald-300' },
    other: { label: 'Other', className: 'bg-bg/60 text-muted' },
  };
  const v = map[platform];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.className}`}>
      {v.label}
    </span>
  );
}

/* ---------- helpers ---------- */

function formatHeaderDate(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function countToday(events: CalendarEventRow[]): number {
  const today = new Date().toDateString();
  return events.filter((e) => new Date(e.start_at).toDateString() === today).length;
}

function describeStatus(
  startIso: string,
  endIso: string,
): { label: string; tone: 'live' | 'soon' | 'later' } | null {
  const now = Date.now();
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();

  if (start <= now && end > now) return { label: 'Live now', tone: 'live' };

  const diffMin = Math.round((start - now) / 60_000);
  if (diffMin <= 0) return null; // already past, shouldn't normally hit
  if (diffMin <= 15) return { label: `In ${diffMin} min`, tone: 'soon' };
  if (diffMin <= 60) return { label: `In ${diffMin} min`, tone: 'soon' };
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return { label: `In ${diffHr} h`, tone: 'later' };
  return null; // > 1 day: row's day-group header tells the user the day
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

function groupByDay(events: CalendarEventRow[]): Array<{ dayKey: string; day: string; events: CalendarEventRow[] }> {
  const groups = new Map<string, CalendarEventRow[]>();
  for (const e of events) {
    const key = new Date(e.start_at).toDateString();
    const bucket = groups.get(key) ?? [];
    bucket.push(e);
    groups.set(key, bucket);
  }
  const today = new Date().toDateString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();

  return Array.from(groups.entries()).map(([dayKey, evs]) => {
    let day: string;
    if (dayKey === today) day = 'Today';
    else if (dayKey === tomorrow) day = 'Tomorrow';
    else
      day = new Date(dayKey).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });
    return { dayKey, day, events: evs };
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ''}${u.pathname.length > 40 ? '…' : ''}`;
  } catch {
    return url.slice(0, 60);
  }
}
