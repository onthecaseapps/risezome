'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../../_lib/auth';
import { addSourceToTeam, removeSourceFromTeam } from '../../../_lib/team-source-lifecycle';

/**
 * Team source-curation actions (teams restructure U7; drives U3's KTD4
 * refcount lifecycle).
 *
 * requireAdmin-gated. These do NOT write `team_sources` directly — they delegate
 * to the lifecycle entrypoints in app/_lib/team-source-lifecycle.ts, which own the
 * index/de-index refcount logic (first reference → index; last reference removed →
 * de-index). orgId is resolved server-side from requireAdmin() and passed through
 * so the lifecycle's org-scoped guards hold.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

/** Select a source for a team. First team to select an un-indexed source kicks
 *  off indexing; a second selection of an already-indexed source is a no-op join. */
export async function addTeamSourceAction(teamId: string, sourceId: string): Promise<ActionResult> {
  const { orgId } = await requireAdmin();
  try {
    await addSourceToTeam({ orgId, teamId, sourceId });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'add_failed' };
  }
  revalidatePath('/settings/teams');
  return { ok: true };
}

/** Deselect a source for a team. When the last team drops it, the lifecycle marks
 *  it 'removed' for the purge cron to de-index. */
export async function removeTeamSourceAction(teamId: string, sourceId: string): Promise<ActionResult> {
  const { orgId } = await requireAdmin();
  try {
    await removeSourceFromTeam({ orgId, teamId, sourceId });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'remove_failed' };
  }
  revalidatePath('/settings/teams');
  return { ok: true };
}
