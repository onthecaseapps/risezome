'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUser } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';

/**
 * Toggle bot_optin on one of the current user's calendar events.
 *
 * Authorization: RLS on calendar_events allows UPDATE only where
 * user_id = auth.uid(), so the user-scoped client is sufficient. We
 * also pass user_id explicitly in the .eq() filter for defense-in-depth.
 *
 * The platform check ('zoom'|'meet' only) lives in the UI; the server
 * happily flips bot_optin for any row the user owns. Future units (U10
 * bot launcher) gate the actual bot dispatch on platform.
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

  const { error } = await supabase
    .from('calendar_events')
    .update({ bot_optin: desired })
    .eq('id', eventId)
    .eq('user_id', user.id);

  if (error !== null) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/upcoming');
  return { ok: true, bot_optin: desired };
}
