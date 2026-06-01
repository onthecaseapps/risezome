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
  const errors: string[] = [];
  for (const resource of selection) {
    // The Atlassian uniqueness rule is a PARTIAL unique index
    // (unique (org_id, kind, external_id) WHERE kind IN ('jira','confluence')),
    // which PostgREST can't use as an `onConflict` arbiter (42P10). Resolve the
    // existing row ourselves, then insert-or-update.
    const { data: existing, error: lookupErr } = await service
      .from('sources')
      .select('id')
      .eq('org_id', orgId)
      .eq('kind', resource.kind)
      .eq('external_id', resource.id)
      .maybeSingle();
    if (lookupErr !== null) {
      errors.push(lookupErr.message);
      continue;
    }

    let sourceId: string;
    if (existing !== null) {
      const { error: updateErr } = await service
        .from('sources')
        .update({
          connection_id: connectionId,
          display_name: resource.name,
          status: 'pending',
          status_message: null,
        })
        .eq('id', existing.id as string);
      if (updateErr !== null) {
        errors.push(updateErr.message);
        continue;
      }
      sourceId = existing.id as string;
    } else {
      const { data: row, error: insertErr } = await service
        .from('sources')
        .insert({
          org_id: orgId,
          kind: resource.kind,
          connection_id: connectionId,
          external_id: resource.id,
          display_name: resource.name,
          status: 'pending',
          status_message: null,
        })
        .select('id')
        .single();
      if (insertErr !== null || row === null) {
        errors.push(insertErr?.message ?? 'source insert returned no row');
        continue;
      }
      sourceId = row.id as string;
    }

    await inngest.send({
      name: EVENT_BY_KIND[resource.kind],
      data: { orgId, sourceId, reason: 'connect', mode: 'full' },
    });
    count += 1;
  }

  revalidatePath('/sources');
  if (count === 0) {
    return { ok: false, error: errors[0] ?? 'No resources were indexed.' };
  }
  return { ok: true, count };
}
