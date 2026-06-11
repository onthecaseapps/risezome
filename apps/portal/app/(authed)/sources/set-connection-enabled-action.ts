'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

export interface SetConnectionEnabledArgs {
  teamId: string;
  /** The connection's source ids (the team's currently-selected items). */
  sourceIds: string[];
  /** true = active in retrieval; false = paused (kept + indexed, not retrieved). */
  enabled: boolean;
}

/**
 * Non-destructive ENABLE/DISABLE of a connection's sources for a team — the
 * top-level source toggle on the Sources page.
 *
 * Flips `team_sources.enabled` for the team's rows. A disabled source keeps its
 * corpus and its team_sources row (the purge refcount is untouched) but is
 * excluded from meeting retrieval via meeting_effective_source_ids. This is NOT
 * a removal: it never de-indexes, never deletes, and re-enabling is instant with
 * no re-index. Removal is `removeConnectionFromTeamAction` / the inner-checkbox
 * deselect path.
 *
 * requireAdmin-gated; team_sources writes are service-role only (members-read RLS).
 */
export async function setConnectionEnabledAction(
  args: SetConnectionEnabledArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { teamId, sourceIds, enabled } = args;
  if (sourceIds.length === 0) return { ok: true }; // nothing selected → no-op

  const { orgId } = await requireAdmin();
  try {
    const service = createServiceRoleClient();

    // Defense-in-depth: only flip sources that belong to this org (service-role
    // bypasses RLS).
    const { data: rows } = await service
      .from('sources')
      .select('id')
      .in('id', sourceIds)
      .eq('org_id', orgId);
    const validSourceIds = (rows ?? []).map((r) => r.id as string);
    if (validSourceIds.length === 0) return { ok: true };

    const { error } = await service
      .from('team_sources')
      .update({ enabled })
      .eq('team_id', teamId)
      .in('source_id', validSourceIds);
    if (error !== null) {
      console.error('[sources.set-enabled] update failed:', error);
      return { ok: false, error: 'update_failed' };
    }

    revalidatePath('/sources');
    return { ok: true };
  } catch (err) {
    console.error('[sources.set-enabled] failed:', err);
    return { ok: false, error: 'update_failed' };
  }
}
