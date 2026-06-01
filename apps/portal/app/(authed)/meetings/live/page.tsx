import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';
import { EndMeetingButton } from './end-button';

/** A meeting older than this stops appearing on Live — it's almost
 * certainly stuck (webhook never delivered bot.call_ended, e.g.
 * because the cloudflared tunnel was down). 6h is generous: typical
 * meetings are an hour or less. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Live meetings list. Shows every meeting in the org that's currently
 * in the bot's "recording" status. Multiple concurrent meetings is the
 * common case for a multi-person team — the sidebar can't smart-link
 * to a single one without picking wrong, so it routes here and lets
 * the user choose.
 *
 * Empty state guides them to /upcoming since that's where bot launches
 * originate. Pre-recording statuses (launching / awaiting_recall /
 * joining / waiting_room) are intentionally excluded — those rows are
 * mid-flight and a user clicking through would land on a /live page
 * with no transcript yet.
 *
 * Stale meetings (status=recording but started_at > 6h ago) are hidden
 * from the listing — the Recall webhook didn't deliver bot.call_ended
 * so the row never moved to completed. The bot-worker also won't have
 * an in-memory runtime for them, so opening /meetings/[id]/live would
 * be misleading. Each visible card carries an "End" button so users
 * can force-complete any meeting that's actually stuck within the
 * window.
 *
 * Refresh cadence: server component on each navigation; the live page
 * itself subscribes to Realtime, so users won't be staring at this
 * list waiting for status to flip.
 */
export default async function LiveMeetingsListPage(): Promise<ReactElement> {
  const { orgId, orgName } = await requireAuthedUserWithOrg();
  const supabase = await createServerClient();

  const freshnessCutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { data: meetingRows } = await supabase
    .from('meetings')
    .select('meeting_id, started_at, calendar_event_id, title')
    .eq('org_id', orgId)
    .eq('status', 'recording')
    .gte('started_at', freshnessCutoff)
    .order('started_at', { ascending: false });

  const meetings = (meetingRows ?? []) as Array<{
    meeting_id: string;
    started_at: string | null;
    calendar_event_id: string | null;
    title: string;
  }>;

  const calendarEventIds = meetings
    .map((m) => m.calendar_event_id)
    .filter((id): id is string => id !== null);

  const titleByEventId = new Map<string, string>();
  if (calendarEventIds.length > 0) {
    const { data: titles } = await supabase
      .from('calendar_events')
      .select('id, title')
      .in('id', calendarEventIds);
    for (const r of titles ?? []) {
      titleByEventId.set(r.id as string, (r.title as string) ?? 'Meeting');
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-rose-400"
          />
          <h1 className="text-2xl font-semibold tracking-tight">Live meetings</h1>
        </div>
        <p className="mt-1.5 text-sm text-muted">
          {meetings.length === 0
            ? `No meetings recording right now in `
            : `Meetings the bot is currently recording in `}
          <span className="text-fg">{orgName}</span>
          {meetings.length === 0 ? '.' : '.'}
        </p>
      </header>

      {meetings.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2">
          {meetings.map((m) => (
            <li key={m.meeting_id}>
              <LiveMeetingCard
                meetingId={m.meeting_id}
                startedAt={m.started_at}
                title={
                  m.title.length > 0
                    ? m.title
                    : m.calendar_event_id !== null && titleByEventId.has(m.calendar_event_id)
                      ? titleByEventId.get(m.calendar_event_id)!
                      : 'Meeting'
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState(): ReactElement {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-14 text-center">
      <h2 className="text-lg font-semibold tracking-tight">No live meetings</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
        Toggle the bot on for a meeting on the{' '}
        <a href="/upcoming" className="text-accent hover:underline">
          Upcoming
        </a>{' '}
        page. Once it joins, the recording will appear here.
      </p>
    </div>
  );
}

function LiveMeetingCard({
  meetingId,
  startedAt,
  title,
}: {
  meetingId: string;
  startedAt: string | null;
  title: string;
}): ReactElement {
  return (
    <div className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent-soft/40">
      <div className="flex w-20 flex-shrink-0 flex-col items-end whitespace-nowrap text-xs text-muted">
        {startedAt !== null ? (
          <>
            <span className="text-sm font-medium text-fg">{formatTime(startedAt)}</span>
            <span>{formatElapsed(startedAt)}</span>
          </>
        ) : (
          <span className="text-sm text-muted">starting…</span>
        )}
      </div>

      <a href={`/meetings/${meetingId}/live`} className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{title}</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-400">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
            Recording
          </span>
        </div>
        <div className="mt-1 text-xs text-muted">Open the live HUD →</div>
      </a>

      <EndMeetingButton meetingId={meetingId} />
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatElapsed(startIso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(startIso).getTime()) / 60_000));
  if (minutes < 1) return 'just started';
  if (minutes < 60) return `${minutes}m in`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}m in`;
}
