'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUser } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { inngest } from '../../../src/inngest/client';

/**
 * Toggle bot_optin on one of the current user's calendar events.
 *
 * Authorization: RLS on calendar_events allows UPDATE only where
 * user_id = auth.uid(), so the user-scoped client is sufficient. We
 * also pass user_id explicitly in the .eq() filter for defense-in-depth.
 *
 * Side effects:
 *   - On toggle ON: fire risezome/bot.scheduled-launch (U8b).
 *     The launcher sleeps until start_at - 90s then re-validates.
 *   - On toggle OFF: NO cancellation event needed. Inngest doesn't
 *     expose per-event cancellation, so the launcher's wake-and-recheck
 *     pattern handles this — when the sleeping function wakes it
 *     re-reads bot_optin and exits if false (see launch-bot.ts).
 *
 * Validation rules (refuse-side):
 *   - eligible platform (zoom or meet) — UI also gates, but defense
 *   - conference_url present
 *   - start_at > now (no scheduling past meetings)
 */
export async function toggleBotOptInAction(
  formData: FormData,
): Promise<{ ok: true; bot_optin: boolean } | { ok: false; error: string }> {
  const eventId = formData.get('eventId');
  const desiredRaw = formData.get('bot_optin');
  if (typeof eventId !== 'string' || eventId.length === 0) {
    return { ok: false, error: 'missing_event_id' };
  }
  const desired = desiredRaw === 'true';

  const user = await requireAuthedUser();
  const supabase = await createServerClient();

  // Read the row first so we can validate platform / URL / time before
  // flipping the bit. The RLS UPDATE policy would silently no-op on a
  // mismatch; an explicit read gives us a clear error to return.
  const { data: eventRow, error: readErr } = await supabase
    .from('calendar_events')
    .select('id, user_id, start_at, conference_url, platform, bot_optin')
    .eq('id', eventId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (readErr !== null) {
    return { ok: false, error: readErr.message };
  }
  if (eventRow === null) {
    return { ok: false, error: 'event_not_found' };
  }

  if (desired) {
    if (eventRow.platform !== 'zoom' && eventRow.platform !== 'meet') {
      return { ok: false, error: 'unsupported_platform' };
    }
    if (typeof eventRow.conference_url !== 'string' || eventRow.conference_url.length === 0) {
      return { ok: false, error: 'no_conference_url' };
    }
    if (new Date(eventRow.start_at as string) <= new Date()) {
      return { ok: false, error: 'past_meeting' };
    }
  }

  const { error: updateErr } = await supabase
    .from('calendar_events')
    .update({ bot_optin: desired })
    .eq('id', eventId)
    .eq('user_id', user.id);
  if (updateErr !== null) {
    return { ok: false, error: updateErr.message };
  }

  if (desired) {
    try {
      await inngest.send({
        name: 'risezome/bot.scheduled-launch',
        data: {
          calendarEventId: eventRow.id as string,
          scheduledStartAt: eventRow.start_at as string,
        },
      });
    } catch (err) {
      // The DB flip succeeded; the scheduling failed. Log + return
      // success so the user's UI reflects opt-in, but they'll need to
      // toggle off/on to retry scheduling. Future: surface a retry CTA.
      // eslint-disable-next-line no-console
      console.error('[toggleBotOptInAction] inngest.send failed:', err);
    }
  }

  revalidatePath('/upcoming');
  return { ok: true, bot_optin: desired };
}
