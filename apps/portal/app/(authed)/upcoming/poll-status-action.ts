'use server';

import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { lookupMeetingsForEvents, type MeetingRow } from './_meetings-lookup';

/**
 * Server action polled by the Upcoming page's live-status provider. Returns
 * the current meeting status for each rendered calendar event, keyed by
 * event id. Auth-scoped to the caller's org; reuses the same lookup the page
 * renders from so polled state matches the initial render exactly.
 */
export async function pollMeetingStatusesAction(
  eventIds: string[],
): Promise<Record<string, MeetingRow>> {
  if (eventIds.length === 0) return {};
  const { orgId } = await requireAuthedUserWithOrg();
  const map = await lookupMeetingsForEvents(orgId, eventIds);
  return Object.fromEntries(map);
}
