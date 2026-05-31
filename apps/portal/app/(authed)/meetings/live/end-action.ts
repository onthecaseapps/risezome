'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { createServiceRoleClient } from '../../../_lib/supabase-server';

/**
 * Force a stuck recording meeting into the completed state. Triggered
 * from the "End now" button on each card in /meetings/live when the
 * Recall webhook never fired bot.call_ended (most commonly: the
 * cloudflared tunnel was down during the meeting's end, or Recall
 * dropped the webhook).
 *
 * Idempotent — re-clicking on an already-completed meeting is a no-op
 * since the WHERE clause requires status='recording'. RLS would
 * normally serve this fine, but we use the service-role client so we
 * can also call the bot-worker's /meetings/:id/end endpoint without
 * threading user cookies through the fetch.
 *
 * Best-effort bot-worker notify — if the worker is down or unreachable
 * we still flip the DB row so the UI reflects reality.
 */
export async function endStuckMeetingAction(
  meetingId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const { error: updateErr } = await service
    .from('meetings')
    .update({ status: 'completed', ended_at: new Date().toISOString() })
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .eq('status', 'recording');
  if (updateErr !== null) return { ok: false, error: updateErr.message };

  // Fire-and-forget: tell the bot-worker to drop in-memory state.
  void notifyBotWorker(meetingId);

  revalidatePath('/meetings/live');
  return { ok: true };
}

async function notifyBotWorker(meetingId: string): Promise<void> {
  const base = process.env['BOT_WORKER_HTTP_URL'];
  if (base === undefined || base.length === 0) return;
  try {
    await fetch(`${base.replace(/\/$/, '')}/meetings/${encodeURIComponent(meetingId)}/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch {
    /* swallow — DB row is already the source of truth */
  }
}
