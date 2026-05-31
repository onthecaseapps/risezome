import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { OptInToggle } from './_opt-in-toggle';
import { SyncNowButton } from './_sync-now-button';

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

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Upcoming</h1>
          <p className="mt-1.5 text-sm text-muted">
            Next 7 days · <span className="text-fg">{orgName}</span>
          </p>
        </div>
        <SyncNowButton />
      </header>

      {error !== null ? (
        <div className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          Failed to load calendar: {error.message}
        </div>
      ) : events.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map((group) => (
            <DayGroup key={group.dayKey} day={group.day} events={group.events} currentUserId={user.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
      <h2 className="text-lg font-semibold tracking-tight">No upcoming meetings</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">
        Your Google Calendar has no events in the next 7 days, or the calendar sync hasn&apos;t
        run yet. Try <span className="text-fg">Sync now</span> above. If you haven&apos;t connected
        Google yet, sign out and back in to grant calendar access.
      </p>
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
