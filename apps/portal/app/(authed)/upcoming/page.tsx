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

export type MeetingStatus =
  | 'launching'
  | 'awaiting_recall'
  | 'joining'
  | 'waiting_room'
  | 'recording'
  | 'completed'
  | 'failed';

export interface MeetingRow {
  meeting_id: string;
  calendar_event_id: string | null;
  status: MeetingStatus;
  error_message: string | null;
  started_at: string | null;
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
  const meetingsByEventId = await lookupMeetingsForEvents(orgId, events.map((e) => e.id));
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
              <DayGroup
                key={group.dayKey}
                day={group.day}
                events={group.events}
                meetingsByEventId={meetingsByEventId}
                currentUserId={user.id}
              />
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
  meetingsByEventId,
  currentUserId,
}: {
  day: string;
  events: CalendarEventRow[];
  meetingsByEventId: Map<string, MeetingRow>;
  currentUserId: string;
}): ReactElement {
  return (
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">{day}</h2>
      <ul className="flex flex-col gap-2">
        {events.map((e) => (
          <li key={e.id}>
            <EventRow event={e} meeting={meetingsByEventId.get(e.id) ?? null} currentUserId={currentUserId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventRow({
  event,
  meeting,
  currentUserId,
}: {
  event: CalendarEventRow;
  meeting: MeetingRow | null;
  currentUserId: string;
}): ReactElement {
  const owned = event.user_id === currentUserId;
  const status = describeRowStatus(event, meeting);
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
      {meeting !== null &&
      (meeting.status === 'recording' ||
        meeting.status === 'joining' ||
        meeting.status === 'awaiting_recall' ||
        meeting.status === 'launching' ||
        meeting.status === 'waiting_room' ||
        meeting.status === 'failed') ? (
        <a
          href={`/meetings/${meeting.meeting_id}/live`}
          className="ml-2 inline-flex h-8 items-center rounded-md border border-border bg-card px-2.5 text-xs font-medium text-fg hover:bg-accent-soft"
          aria-label={meeting.status === 'recording' ? 'Open live view' : 'Open meeting'}
        >
          {meeting.status === 'recording' ? 'Open live view' : 'View meeting'}
        </a>
      ) : null}
    </div>
  );
}

interface RowStatus {
  label: string;
  tone: 'live' | 'launching' | 'joining' | 'soon' | 'later' | 'failed';
  tooltip?: string;
}

function StatusChip({ status }: { status: RowStatus | null }): ReactElement | null {
  if (status === null) return null;
  const map: Record<RowStatus['tone'], string> = {
    live: 'bg-rose-500/20 text-rose-300 animate-pulse',
    launching: 'bg-accent-soft text-accent',
    joining: 'bg-accent-soft text-accent',
    soon: 'bg-accent-soft text-accent',
    later: 'bg-bg/60 text-muted',
    failed: 'bg-rose-500/15 text-rose-300',
  };
  return (
    <span
      title={status.tooltip}
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${map[status.tone]}`}
    >
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

/**
 * Pick the row's status chip. Priority order matters — bot lifecycle
 * states dominate the time-based label so the user always sees the
 * most useful information.
 */
function describeRowStatus(event: CalendarEventRow, meeting: MeetingRow | null): RowStatus | null {
  const now = Date.now();
  const start = new Date(event.start_at).getTime();
  const end = new Date(event.end_at).getTime();

  // 1. Meeting in flight / live / failed — these all dominate.
  if (meeting !== null) {
    if (meeting.status === 'recording') {
      const mins = meeting.started_at !== null
        ? Math.max(0, Math.round((now - new Date(meeting.started_at).getTime()) / 60_000))
        : 0;
      return { label: `Live now${mins > 0 ? ` · ${mins}m in` : ''}`, tone: 'live' };
    }
    if (meeting.status === 'failed') {
      return {
        label: 'Bot launch failed',
        tone: 'failed',
        tooltip: meeting.error_message ?? 'Check the meeting URL and try toggling off + on',
      };
    }
    if (
      meeting.status === 'launching' ||
      meeting.status === 'awaiting_recall' ||
      meeting.status === 'joining' ||
      meeting.status === 'waiting_room'
    ) {
      return { label: 'Bot joining…', tone: 'joining' };
    }
    // 'completed' falls through to time-based handling
  }

  // 2. Live (no meeting record — user didn't opt in, but the meeting is happening).
  if (start <= now && end > now) {
    return event.bot_optin
      ? { label: 'Starting now', tone: 'launching' }
      : { label: 'Live (no bot)', tone: 'later' };
  }

  // 3. Bot scheduled + start imminent.
  if (event.bot_optin && start > now) {
    const diffMin = Math.round((start - now) / 60_000);
    if (diffMin <= 15) return { label: `Bot launching in ${diffMin} min`, tone: 'launching' };
    if (diffMin <= 60) return { label: `Bot scheduled · in ${diffMin} min`, tone: 'soon' };
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return { label: `Bot scheduled · in ${diffHr}h`, tone: 'soon' };
    return { label: 'Bot scheduled', tone: 'soon' };
  }

  // 4. Plain time-based label for non-opted-in upcoming events.
  const diffMin = Math.round((start - now) / 60_000);
  if (diffMin <= 0) return null;
  if (diffMin <= 60) return { label: `In ${diffMin} min`, tone: 'soon' };
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return { label: `In ${diffHr} h`, tone: 'later' };
  return null;
}

/**
 * Bulk-fetch meetings linked to the events being rendered. Returns a
 * Map keyed by calendar_event_id; non-existent links are absent.
 *
 * We restrict to non-failed rows so a stale failure doesn't shadow a
 * new in-flight launch (e.g., user re-toggles after fixing the URL).
 * The active-row uniqueness from the partial index guarantees at most
 * one such row per event.
 */
async function lookupMeetingsForEvents(
  orgId: string,
  eventIds: string[],
): Promise<Map<string, MeetingRow>> {
  const out = new Map<string, MeetingRow>();
  if (eventIds.length === 0) return out;

  const service = createServiceRoleClient();
  const { data } = await service
    .from('meetings')
    .select('meeting_id, calendar_event_id, status, error_message, started_at')
    .eq('org_id', orgId)
    .in('calendar_event_id', eventIds)
    .neq('status', 'failed');

  for (const row of data ?? []) {
    const eventId = row.calendar_event_id as string | null;
    if (eventId === null) continue;
    out.set(eventId, {
      meeting_id: row.meeting_id as string,
      calendar_event_id: eventId,
      status: row.status as MeetingStatus,
      error_message: (row.error_message as string | null) ?? null,
      started_at: (row.started_at as string | null) ?? null,
    });
  }

  // Also surface the latest FAILED launch when no active row exists, so
  // the user sees the failure on the row and can retry by toggling.
  const eventsWithMeeting = new Set(out.keys());
  const failedEventIds = eventIds.filter((id) => !eventsWithMeeting.has(id));
  if (failedEventIds.length > 0) {
    const { data: failed } = await service
      .from('meetings')
      .select('meeting_id, calendar_event_id, status, error_message, started_at')
      .eq('org_id', orgId)
      .in('calendar_event_id', failedEventIds)
      .eq('status', 'failed')
      .order('updated_at', { ascending: false });

    const seen = new Set<string>();
    for (const row of failed ?? []) {
      const eventId = row.calendar_event_id as string | null;
      if (eventId === null || seen.has(eventId)) continue;
      seen.add(eventId);
      out.set(eventId, {
        meeting_id: row.meeting_id as string,
        calendar_event_id: eventId,
        status: 'failed',
        error_message: (row.error_message as string | null) ?? null,
        started_at: (row.started_at as string | null) ?? null,
      });
    }
  }

  return out;
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
