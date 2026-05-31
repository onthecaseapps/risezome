'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest } from '../../../src/inngest/client';

/**
 * User-initiated reindex of a single source. Verifies the user is a member
 * of the org that owns the source (defense-in-depth — RLS would block the
 * row lookup anyway), then emits a `risezome/source.index-requested` event
 * with reason='reindex'. The Inngest function picks it up the same way it
 * handles install-time events.
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

  const { orgId } = await requireAuthedUserWithOrg();

  const service = createServiceRoleClient();
  const { data: source, error } = await service
    .from('sources')
    .select('id, kind')
    .eq('id', sourceId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error !== null || source === null) {
    return { ok: false, error: 'source_not_found' };
  }

  // Mark pending immediately so the UI flips before Inngest picks it up;
  // the function itself transitions to 'indexing' as its first step.
  await service
    .from('sources')
    .update({ status: 'pending', status_message: null })
    .eq('id', sourceId);

  // Dispatch by kind: each connector has its own indexer + event, so a source
  // only triggers its own indexer.
  const eventByKind: Record<string, 'risezome/trello.index-requested' | 'risezome/jira.index-requested' | 'risezome/confluence.index-requested'> = {
    trello: 'risezome/trello.index-requested',
    jira: 'risezome/jira.index-requested',
    confluence: 'risezome/confluence.index-requested',
  };
  const kindEvent = eventByKind[source.kind as string];
  if (kindEvent !== undefined) {
    await inngest.send({ name: kindEvent, data: { orgId, sourceId, reason: 'reindex' } });
  } else {
    await inngest.send({
      name: 'risezome/source.index-requested',
      data: { orgId, sourceId, reason: 'reindex' },
    });
  }

  revalidatePath('/sources');
  return { ok: true };
}
