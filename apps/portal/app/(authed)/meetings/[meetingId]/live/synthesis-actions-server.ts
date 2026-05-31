'use server';

import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServiceRoleClient } from '../../../../_lib/supabase-server';

/**
 * Pin or unpin a synthesis (plan U5). Service-role write that mirrors
 * the existing pinCardAction shape exactly — same auth check pattern,
 * same client choice, same explicit org-membership filter on the
 * UPDATE, same per-tab optimistic dispatch convention in the caller.
 *
 * Pin-state broadcasting is deliberately NOT wired in V1 — cross-tab
 * pin sync is deferred per the plan's Scope Boundaries. When that
 * follow-up ships it adds broadcast + a Realtime handler in
 * realtime-meeting-channel.ts; until then the only consumer of the
 * pin state is the same tab that fired the action (via the optimistic
 * `synthesisPinned` dispatch in _client.tsx).
 *
 * Return shape mirrors pinCardAction so the caller's
 * `if (!result.ok) rollback()` pattern stays identical.
 */
export async function pinSynthesisAction(
  synthesisId: string,
  pinned: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const update: Record<string, unknown> = {
    pinned,
    pinned_at: pinned ? new Date().toISOString() : null,
  };

  const { error: updateErr } = await service
    .from('syntheses')
    .update(update)
    .eq('synthesis_id', synthesisId)
    .eq('org_id', orgId);
  if (updateErr !== null) return { ok: false, error: updateErr.message };

  return { ok: true };
}
