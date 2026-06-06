'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../../../_lib/supabase-server';
import { inngest } from '../../../../../src/inngest/client';
import {
  regenerateRecap,
  type RegenerateRecapResult,
} from './regenerate-recap-core';

/**
 * Regenerate the structured recap for a meeting (U6). Authorized via the
 * participant-scoped RLS SELECT (attendees ∪ super-admin), then re-fires the
 * recap pipeline. The button disables while recap_status==='generating'; the
 * function's concurrency:1 per meetingId prevents a double-run.
 */
export async function regenerateRecapAction(meetingId: string): Promise<RegenerateRecapResult> {
  const { orgId } = await requireAuthedUserWithOrg();
  const rls = await createServerClient();
  const service = createServiceRoleClient();
  const result = await regenerateRecap(
    {
      orgId,
      rls: rls as unknown as Parameters<typeof regenerateRecap>[0]['rls'],
      service: service as unknown as Parameters<typeof regenerateRecap>[0]['service'],
      send: (event) => inngest.send(event),
    },
    meetingId,
  );
  // Re-render the review page so the new 'generating' status shows immediately.
  if (result.ok) revalidatePath(`/meetings/${meetingId}/review`);
  return result;
}
