'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest, type IndexMode } from '../../../src/inngest/client';

/**
 * User-initiated reindex of a single source. Verifies the user is a member
 * of the org that owns the source (defense-in-depth — RLS would block the
 * row lookup anyway), then emits the source's kind-specific index event.
 *
 * `mode` (from the chosen menu item):
 *   - `delta` — index new + changed, skip unchanged, no prune. Default.
 *   - `full`  — also delete items the source no longer has.
 * An unrecognized/missing `mode` form value falls back to `delta` (safe:
 * never prunes unexpectedly).
 *
 * Returns a small status object so the calling client can show a toast or
 * inline confirmation. We don't wait for the indexer to finish — it could
 * take minutes; the page polls for status updates instead.
 */
export async function reindexSourceAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sourceId = formData.get('sourceId');
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return { ok: false, error: 'missing_source_id' };
  }
  const mode: IndexMode = formData.get('mode') === 'full' ? 'full' : 'delta';

  const { orgId } = await requireAuthedUserWithOrg();

  const service = createServiceRoleClient();
  const { data: source, error } = await service
    .from('sources')
    .select('id, kind, status')
    .eq('id', sourceId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error !== null || source === null) {
    return { ok: false, error: 'source_not_found' };
  }
  // A removed (deselected, awaiting purge) source must not be reindexed —
  // that would resurrect content the admin de-selected. Re-enabling goes
  // through the team-selection lifecycle, which revives properly.
  if (source.status === 'removed') {
    return { ok: false, error: 'source_removed' };
  }

  // Mark pending immediately so the UI flips before Inngest picks it up;
  // the function itself transitions to 'indexing' as its first step.
  await service
    .from('sources')
    .update({ status: 'pending', status_message: null })
    .eq('id', sourceId)
    .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    .neq('status', 'removed'); // removal is sticky (race with a concurrent deselect)

  // Dispatch by kind: each connector has its own indexer + event, so a source
  // only triggers its own indexer.
  const eventByKind: Record<string, 'risezome/trello.index-requested' | 'risezome/jira.index-requested' | 'risezome/confluence.index-requested'> = {
    trello: 'risezome/trello.index-requested',
    jira: 'risezome/jira.index-requested',
    confluence: 'risezome/confluence.index-requested',
  };
  const kindEvent = eventByKind[source.kind as string];
  if (kindEvent !== undefined) {
    await inngest.send({ name: kindEvent, data: { orgId, sourceId, reason: 'reindex', mode } });
  } else {
    await inngest.send({
      name: 'risezome/source.index-requested',
      data: { orgId, sourceId, reason: 'reindex', mode },
    });
  }

  revalidatePath('/sources');
  return { ok: true };
}
