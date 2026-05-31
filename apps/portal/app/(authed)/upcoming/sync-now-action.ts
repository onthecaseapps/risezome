'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { inngest } from '../../../src/inngest/client';

/**
 * Manual "Sync now" — fire an immediate calendar.sync-requested event
 * instead of waiting for the 5-min cron. Useful for dogfooding +
 * recovering from missed events without rebooting the dev server.
 */
export async function syncNowAction(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { user, orgId } = await requireAuthedUserWithOrg();
  try {
    await inngest.send({
      name: 'risezome/calendar.sync-requested',
      data: { userId: user.id, orgId, reason: 'manual' },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/upcoming');
  return { ok: true };
}
