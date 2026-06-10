'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { OptInToggle } from './_opt-in-toggle';
import { LiveStatusChip, LiveMeetingCta } from './_live-status';

/**
 * Client-side day grouping + time labels for the Upcoming page. The server
 * component fetches a flat, start_at-sorted event list and hands it down as
 * ISO strings; everything zone-dependent (which day an event belongs to, the
 * "Today"/"Tomorrow" headers, the per-event time labels, the "N today" count)
 * is computed here in the BROWSER's zone. Rendering these on the server used
 * the server's zone — a PST user's 6 PM meeting showed as "2:00 AM" under
 * "Tomorrow" and never corrected.
 *
 * Hydration: the time-label/count text nodes format in the local zone directly
 * and carry suppressHydrationWarning (same discipline as LiveStatusChip). The
 * grouping STRUCTURE can't be suppressed, so SSR and the first client render
 * both group in UTC (deterministic match) and an effect re-groups in the real
 * local zone immediately after mount.
 */

export interface CalendarEventRow {
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

/** Header subtitle: weekday/date + "N today", in the browser's locale/zone. */
export function HeaderSubtitle({
  startAtIsos,
  orgName,
}: {
  startAtIsos: readonly string[];
  orgName: string;
}): ReactElement {
  const todayKey = new Date().toLocaleDateString('en-CA');
  const todayCount = startAtIsos.filter(
    (iso) => new Date(iso).toLocaleDateString('en-CA') === todayKey,
  ).length;
  const headerDate = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  return (
    <p className="mt-2 text-pretty text-muted">
      <span suppressHydrationWarning>
        {headerDate} {todayCount > 0 ? `· ${String(todayCount)} today` : '· no meetings today'}
      </span>
      <span className="ml-1 text-muted/70">· {orgName}</span>
    </p>
  );
}

export function DayGroups({
  events,
  currentUserId,
}: {
  events: CalendarEventRow[];
  currentUserId: string;
}): ReactElement {
  // UTC for SSR + first client render (hydration-safe), then the local zone.
  const [zone, setZone] = useState('UTC');
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const grouped = useMemo(() => groupEventsByDay(events, zone), [events, zone]);

  return (
    <div className="flex flex-col gap-6">
      {grouped.map((group) => (
        <DayGroup key={group.dayKey} day={group.day} events={group.events} currentUserId={currentUserId} />
      ))}
    </div>
  );
}

/** Y-M-D of the instant in `timeZone` (en-CA renders ISO-style YYYY-MM-DD). */
function ymdInZone(d: Date, timeZone: string): string {
  return d.toLocaleDateString('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Group a start_at-sorted event list into calendar days in `timeZone`, with
 * "Today"/"Tomorrow"/weekday labels. "Tomorrow" comes from calendar-date
 * arithmetic on Y/M/D — NOT now + 24h, which lands on the wrong day around a
 * DST transition (e.g. spring-forward makes +24h skip the next calendar day).
 * Pure + exported for unit testing.
 */
export function groupEventsByDay<T extends { start_at: string }>(
  events: readonly T[],
  timeZone: string,
  now: Date = new Date(),
): Array<{ dayKey: string; day: string; events: T[] }> {
  const groups = new Map<string, T[]>();
  for (const e of events) {
    const key = ymdInZone(new Date(e.start_at), timeZone);
    const bucket = groups.get(key) ?? [];
    bucket.push(e);
    groups.set(key, bucket);
  }

  const today = ymdInZone(now, timeZone);
  const [y = 0, m = 1, d = 1] = today.split('-').map(Number);
  // Date.UTC normalizes day overflow (Jan 32 → Feb 1); noon keeps the ISO
  // date stable. This is pure calendar math, so DST shifts can't touch it.
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);

  return Array.from(groups.entries()).map(([dayKey, evs]) => {
    let day: string;
    if (dayKey === today) day = 'Today';
    else if (dayKey === tomorrow) day = 'Tomorrow';
    else {
      const [gy = 0, gm = 1, gd = 1] = dayKey.split('-').map(Number);
      day = new Date(Date.UTC(gy, gm - 1, gd, 12)).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    }
    return { dayKey, day, events: evs };
  });
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
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-[var(--card-shadow)]">
      <div className="flex w-20 flex-shrink-0 flex-col items-end whitespace-nowrap text-xs text-muted">
        <span suppressHydrationWarning className="text-sm font-medium text-fg">
          {formatTime(event.start_at)}
        </span>
        <span suppressHydrationWarning>{formatTime(event.end_at)}</span>
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
          <LiveStatusChip
            event={{ start_at: event.start_at, end_at: event.end_at, bot_optin: event.bot_optin }}
            eventId={event.id}
          />
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

      {/* Open-live-view button sits to the LEFT of the bot toggle so the
          toggle is always the rightmost control in the row (matches the
          mockup). Driven live by the polled meeting status. */}
      <LiveMeetingCta eventId={event.id} />
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

function PlatformBadge({ platform }: { platform: 'zoom' | 'meet' | 'other' | null }): ReactElement | null {
  if (platform === null) return null;
  const map: Record<NonNullable<typeof platform>, { label: string; className: string }> = {
    zoom: { label: 'Zoom', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
    meet: { label: 'Meet', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
    other: { label: 'Other', className: 'bg-bg/60 text-muted' },
  };
  const v = map[platform];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.className}`}>
      {v.label}
    </span>
  );
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
