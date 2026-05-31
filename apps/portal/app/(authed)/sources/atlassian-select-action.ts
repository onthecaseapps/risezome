'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest } from '../../../src/inngest/client';

interface ResourceSelection {
  kind: 'jira' | 'confluence';
  id: string;
  name: string;
}

const EVENT_BY_KIND = {
  jira: 'risezome/jira.index-requested',
  confluence: 'risezome/confluence.index-requested',
} as const;

/**
 * Index the selected Atlassian resources (Jira projects and/or Confluence
 * spaces). For each, upsert one source of the matching kind (bound to the org's
 * Atlassian connection) and emit the kind's index event. Upsert keys on
 * (org_id, kind, external_id) so re-selecting doesn't duplicate.
 */
export async function selectAtlassianResourcesAction(
  formData: FormData,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const raw = formData.get('selection');
  if (typeof raw !== 'string') return { ok: false, error: 'missing_selection' };

  let selection: ResourceSelection[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    selection = parsed
      .map((b) => b as Record<string, unknown>)
      .filter(
        (b) =>
          (b['kind'] === 'jira' || b['kind'] === 'confluence') &&
          typeof b['id'] === 'string' &&
          typeof b['name'] === 'string',
      )
      .map((b) => ({ kind: b['kind'] as 'jira' | 'confluence', id: b['id'] as string, name: b['name'] as string }));
  } catch {
    return { ok: false, error: 'bad_selection' };
  }
  if (selection.length === 0) return { ok: false, error: 'empty_selection' };

  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const { data: conn, error: connErr } = await service
    .from('atlassian_connections')
    .select('id')
    .eq('org_id', orgId)
    .maybeSingle();
  if (connErr !== null || conn === null) {
    return { ok: false, error: 'atlassian_not_connected' };
  }
  const connectionId = conn.id as string;

  let count = 0;
  for (const resource of selection) {
    const { data: row, error: upsertErr } = await service
      .from('sources')
      .upsert(
        {
          org_id: orgId,
          kind: resource.kind,
          connection_id: connectionId,
          external_id: resource.id,
          display_name: resource.name,
          status: 'pending',
          status_message: null,
        },
        { onConflict: 'org_id,kind,external_id' },
      )
      .select('id')
      .single();
    if (upsertErr !== null || row === null) continue;

    await inngest.send({
      name: EVENT_BY_KIND[resource.kind],
      data: { orgId, sourceId: row.id as string, reason: 'connect' },
    });
    count += 1;
  }

  revalidatePath('/sources');
  return { ok: true, count };
}
