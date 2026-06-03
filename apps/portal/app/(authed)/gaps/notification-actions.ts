'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';

/**
 * Notification actions (plan U12). A user marks their OWN notifications read —
 * RLS already restricts both the SELECT and the UPDATE to user_id = auth.uid(),
 * so the RLS-scoped authed client is sufficient (no service role needed). Used
 * by the toast "Dismiss" and when opening a gap from a notification.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

export async function markNotificationReadAction(notificationId: number): Promise<ActionResult> {
  await requireAuthedUserWithOrg();
  const supabase = await createServerClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('notification_id', notificationId)
    .is('read_at', null);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}
