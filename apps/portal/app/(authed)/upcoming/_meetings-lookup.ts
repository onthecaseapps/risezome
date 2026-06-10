import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Shared meeting-status lookup for the Upcoming page. Used by both the
 * server-rendered page (initial render) and the poll-status server action
 * (live updates) so the two paths stay byte-for-byte consistent.
 */

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

/**
 * Bulk-fetch meetings linked to the events being rendered. Returns a Map
 * keyed by calendar_event_id; non-existent links are absent.
 *
 * We restrict to non-failed rows so a stale failure doesn't shadow a new
 * in-flight launch (e.g., user re-toggles after fixing the URL). The
 * active-row uniqueness from the partial index guarantees at most one such
 * row per event. A latest FAILED launch is surfaced only when no active row
 * exists, so the user can retry by toggling.
 *
 * Uses the service-role client so teammate-owned meetings (where the viewer
 * isn't a meeting participant) still surface their status on the org's
 * Upcoming list — matching the page's existing read model.
 */
export async function lookupMeetingsForEvents(
  orgId: string,
  eventIds: string[],
): Promise<Map<string, MeetingRow>> {
  const out = new Map<string, MeetingRow>();
  if (eventIds.length === 0) return out;

  const service = createServiceRoleClient();
  // created_at ASC so a later (newer) row wins the map write when one event
  // carries both a 'completed' row and a relaunch — without it row order is
  // arbitrary and the status chip flickers between renders. preferMeetingRow
  // additionally keeps an active row over a 'completed' one regardless of age.
  const { data } = await service
    .from('meetings')
    .select('meeting_id, calendar_event_id, status, error_message, started_at')
    .eq('org_id', orgId)
    .in('calendar_event_id', eventIds)
    .neq('status', 'failed')
    .order('created_at', { ascending: true });

  for (const row of data ?? []) {
    const eventId = row.calendar_event_id as string | null;
    if (eventId === null) continue;
    const candidate: MeetingRow = {
      meeting_id: row.meeting_id as string,
      calendar_event_id: eventId,
      status: row.status as MeetingStatus,
      error_message: (row.error_message as string | null) ?? null,
      started_at: (row.started_at as string | null) ?? null,
    };
    out.set(eventId, preferMeetingRow(out.get(eventId), candidate));
  }

  // Surface the latest FAILED launch when no active row exists.
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
 * Pick which of two non-failed rows for the SAME calendar event should drive
 * the status chip. Active (in-flight/recording) statuses outrank 'completed' —
 * a relaunch after a completed run must surface as live, not done. Within the
 * same tier the candidate wins: callers iterate in created_at ASC order, so
 * the newest row prevails. Pure + exported for unit testing.
 */
export function preferMeetingRow(current: MeetingRow | undefined, candidate: MeetingRow): MeetingRow {
  if (current === undefined) return candidate;
  const rank = (s: MeetingStatus): number => (s === 'completed' || s === 'failed' ? 0 : 1);
  return rank(candidate.status) >= rank(current.status) ? candidate : current;
}
