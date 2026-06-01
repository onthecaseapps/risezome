import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';

/**
 * Captures — the historical record of past meetings the bot attended.
 * Lists meetings in terminal states (completed or failed) for the
 * current org. Each row links to /meetings/[id]/review.
 *
 * `recording` meetings are excluded — those belong on Live meeting in
 * the sidebar. `launching` / `awaiting_recall` / `joining` /
 * `waiting_room` are mid-flight and don't surface here either.
 *
 * Grouping: by day of started_at (Today / Yesterday / Mon, Jun 2). A
 * follow-up could add filters (only failed, only with cards, etc.) —
 * for V1 the chronological dump matches the captures mockup.
 */

interface CaptureRow {
  meeting_id: string;
  status: 'completed' | 'failed';
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  error_code: string | null;
  error_message: string | null;
  calendar_event_id: string | null;
  card_count: number;
  synthesis_count: number;
  title: string;
}

export default async function CapturesPage(): Promise<ReactElement> {
  const { orgId, orgName } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const { data: meetingRows } = await supabase
    .from('meetings')
    .select(
      'meeting_id, status, started_at, ended_at, error_code, error_message, calendar_event_id, title, created_at',
    )
    .eq('org_id', orgId)
    .in('status', ['completed', 'failed'])
    .order('created_at', { ascending: false })
    .limit(100);

  const meetings = (meetingRows ?? []) as Array<{
    meeting_id: string;
    status: 'completed' | 'failed';
    started_at: string | null;
    ended_at: string | null;
    error_code: string | null;
    error_message: string | null;
    calendar_event_id: string | null;
    title: string;
    created_at: string;
  }>;

  // Bulk-fetch titles + per-meeting card/synthesis counts. Two more
  // round-trips, but at 100-meeting cap the total is small.
  const meetingIds = meetings.map((m) => m.meeting_id);
  const calendarEventIds = meetings
    .map((m) => m.calendar_event_id)
    .filter((id): id is string => id !== null);

  const [titlesResult, cardsResult, synthsResult] = await Promise.all([
    calendarEventIds.length > 0
      ? supabase.from('calendar_events').select('id, title').in('id', calendarEventIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }> }),
    meetingIds.length > 0
      ? supabase
          .from('cards')
          .select('meeting_id')
          .in('meeting_id', meetingIds)
          .is('retracted_at', null)
      : Promise.resolve({ data: [] as Array<{ meeting_id: string }> }),
    meetingIds.length > 0
      ? supabase
          .from('syntheses')
          .select('meeting_id')
          .in('meeting_id', meetingIds)
          .eq('status', 'done')
          .is('retracted_at', null)
      : Promise.resolve({ data: [] as Array<{ meeting_id: string }> }),
  ]);

  const titleByEventId = new Map(
    (titlesResult.data ?? []).map((r) => [r.id as string, (r.title as string) ?? '']),
  );
  const cardCountByMeeting = new Map<string, number>();
  for (const row of cardsResult.data ?? []) {
    const id = row.meeting_id as string;
    cardCountByMeeting.set(id, (cardCountByMeeting.get(id) ?? 0) + 1);
  }
  const synthCountByMeeting = new Map<string, number>();
  for (const row of synthsResult.data ?? []) {
    const id = row.meeting_id as string;
    synthCountByMeeting.set(id, (synthCountByMeeting.get(id) ?? 0) + 1);
  }

  const captures: CaptureRow[] = meetings.map((m) => ({
    meeting_id: m.meeting_id,
    status: m.status,
    started_at: m.started_at,
    ended_at: m.ended_at,
    created_at: m.created_at,
    error_code: m.error_code,
    error_message: m.error_message,
    calendar_event_id: m.calendar_event_id,
    card_count: cardCountByMeeting.get(m.meeting_id) ?? 0,
    synthesis_count: synthCountByMeeting.get(m.meeting_id) ?? 0,
    title:
      m.title.length > 0
        ? m.title
        : m.calendar_event_id !== null && titleByEventId.has(m.calendar_event_id)
          ? titleByEventId.get(m.calendar_event_id)!
          : 'Meeting',
  }));

  const grouped = groupByDay(captures);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Captures</h1>
        <p className="mt-1.5 text-sm text-muted">
          Past meetings the bot attended for <span className="text-fg">{orgName}</span>.
        </p>
      </header>

      {captures.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map((group) => (
            <section key={group.dayKey}>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
                {group.day}
              </h2>
              <ul className="flex flex-col gap-2">
                {group.items.map((c) => (
                  <li key={c.meeting_id}>
                    <CaptureRowCard capture={c} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
      <h2 className="text-lg font-semibold tracking-tight">No captures yet</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
        Meetings the Risezome bot attended will appear here once they wrap. Toggle the bot on
        for a meeting on the <a href="/upcoming" className="text-accent hover:underline">Upcoming</a> page to get started.
      </p>
    </div>
  );
}

function CaptureRowCard({ capture }: { capture: CaptureRow }): ReactElement {
  return (
    <a
      href={`/meetings/${capture.meeting_id}/review`}
      className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent-soft/40"
    >
      <div className="flex w-20 flex-shrink-0 flex-col items-end whitespace-nowrap text-xs text-muted">
        {capture.started_at !== null ? (
          <span className="text-sm font-medium text-fg">{formatTime(capture.started_at)}</span>
        ) : (
          <span className="text-sm text-muted">—</span>
        )}
        <span>{formatDuration(capture.started_at, capture.ended_at)}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{capture.title}</span>
          <StatusBadge status={capture.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          {capture.status === 'completed' ? (
            <>
              <span>
                {capture.card_count} card{capture.card_count === 1 ? '' : 's'}
              </span>
              {capture.synthesis_count > 0 ? (
                <span>
                  · {capture.synthesis_count} synthesis{capture.synthesis_count === 1 ? '' : 'es'}
                </span>
              ) : null}
            </>
          ) : capture.error_message !== null ? (
            <span className="truncate text-rose-400">{capture.error_message}</span>
          ) : capture.error_code !== null ? (
            <span className="font-mono text-rose-400">{capture.error_code}</span>
          ) : (
            <span className="text-rose-400">Failed</span>
          )}
        </div>
      </div>

      <span className="text-muted">→</span>
    </a>
  );
}

function StatusBadge({ status }: { status: 'completed' | 'failed' }): ReactElement {
  const map = {
    completed: { label: 'Recorded', className: 'bg-emerald-500/15 text-emerald-400' },
    failed: { label: 'Failed', className: 'bg-rose-500/15 text-rose-400' },
  };
  const v = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.className}`}
    >
      {v.label}
    </span>
  );
}

function groupByDay(
  items: CaptureRow[],
): Array<{ dayKey: string; day: string; items: CaptureRow[] }> {
  const groups = new Map<string, CaptureRow[]>();
  for (const c of items) {
    // Failed meetings have started_at AND ended_at = null (the bot
    // never reached "in_call"). Fall back to created_at, which the
    // launcher always populates, so they group under the day the user
    // tried to start the bot rather than landing in an "Unknown date"
    // bucket.
    const ts = c.started_at ?? c.ended_at ?? c.created_at;
    const key = new Date(ts).toDateString();
    const bucket = groups.get(key) ?? [];
    bucket.push(c);
    groups.set(key, bucket);
  }
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();

  return Array.from(groups.entries()).map(([dayKey, list]) => {
    let day: string;
    if (dayKey === today) day = 'Today';
    else if (dayKey === yesterday) day = 'Yesterday';
    else
      day = new Date(dayKey).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });
    return { dayKey, day, items: list };
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (startIso === null || endIso === null) return '';
  const minutes = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  );
  if (minutes <= 0) return '0m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}m`;
}
