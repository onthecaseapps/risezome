'use server';

import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServiceRoleClient } from '../../../../_lib/supabase-server';
import { inngest } from '../../../../../src/inngest/client';

/**
 * Retry a failed bot launch from the live meeting page's FailureShell.
 *
 * The launch flow (U8b's `launch-bot` function) creates a meetings row
 * with status='failed' on a 4xx from Recall. The partial unique index
 * on meetings only covers status != 'failed', so we can fire a fresh
 * `risezome/bot.scheduled-launch` event — the next attempt creates a
 * new meetings row.
 *
 * We look up the underlying calendar_event_id from the failed meeting
 * and re-emit the schedule event with the same scheduledStartAt. If
 * the meeting time has already passed, the launcher's launchAt guard
 * (< new Date()) skips the sleep and fires immediately.
 */
export async function retryFailedLaunchAction(
  meetingId: string,
): Promise<{ ok: true; calendarEventId: string } | { ok: false; error: string }> {
  const { orgId, canInviteBot } = await requireAuthedUserWithOrg();

  // R7: relaunching the bot requires the manager role or the can_invite_bot
  // grant. Gated on role, not participation — a failed meeting has no
  // participant set to check against.
  if (!canInviteBot) {
    return { ok: false, error: 'bot_invite_not_permitted' };
  }

  const service = createServiceRoleClient();

  const { data: meeting, error: lookupErr } = await service
    .from('meetings')
    .select('meeting_id, org_id, status, calendar_event_id')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (lookupErr !== null) return { ok: false, error: lookupErr.message };
  if (meeting === null) return { ok: false, error: 'meeting_not_found' };
  if (meeting.status !== 'failed') return { ok: false, error: 'not_failed' };
  if (meeting.calendar_event_id === null) return { ok: false, error: 'no_calendar_event' };

  const { data: calEvent, error: calErr } = await service
    .from('calendar_events')
    .select('id, start_at, bot_optin')
    .eq('id', meeting.calendar_event_id)
    .maybeSingle();
  if (calErr !== null) return { ok: false, error: calErr.message };
  if (calEvent === null) return { ok: false, error: 'calendar_event_deleted' };

  // Make sure bot_optin is still TRUE — the launcher's reload-event
  // step exits early if it's false, which would make the retry a
  // no-op. Toggle it on if necessary; the user clearly wants the bot
  // since they clicked Retry.
  if (calEvent.bot_optin !== true) {
    const { error: updateErr } = await service
      .from('calendar_events')
      .update({ bot_optin: true })
      .eq('id', meeting.calendar_event_id);
    if (updateErr !== null) return { ok: false, error: updateErr.message };
  }

  await inngest.send({
    name: 'risezome/bot.scheduled-launch',
    data: {
      calendarEventId: meeting.calendar_event_id as string,
      scheduledStartAt: calEvent.start_at as string,
    },
  });

  return { ok: true, calendarEventId: meeting.calendar_event_id as string };
}
