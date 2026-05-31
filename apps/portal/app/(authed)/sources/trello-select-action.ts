'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest } from '../../../src/inngest/client';

interface BoardSelection {
  id: string;
  name: string;
}

/**
 * Index the selected Trello boards. For each chosen board we upsert one
 * `kind='trello'` source (bound to the org's connection) and emit a
 * `trello.index-requested` event. Upsert keys on (org_id, external_id) so
 * re-selecting an already-indexed board re-uses its row rather than duplicating.
 */
export async function selectTrelloBoardsAction(
  formData: FormData,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const raw = formData.get('selection');
  if (typeof raw !== 'string') return { ok: false, error: 'missing_selection' };

  let selection: BoardSelection[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    selection = parsed
      .map((b) => b as Record<string, unknown>)
      .filter((b) => typeof b['id'] === 'string' && typeof b['name'] === 'string')
      .map((b) => ({ id: b['id'] as string, name: b['name'] as string }));
  } catch {
    return { ok: false, error: 'bad_selection' };
  }
  if (selection.length === 0) return { ok: false, error: 'empty_selection' };

  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const { data: conn, error: connErr } = await service
    .from('trello_connections')
    .select('id')
    .eq('org_id', orgId)
    .maybeSingle();
  if (connErr !== null || conn === null) {
    return { ok: false, error: 'trello_not_connected' };
  }
  const connectionId = conn.id as string;

  let count = 0;
  for (const board of selection) {
    const { data: row, error: upsertErr } = await service
      .from('sources')
      .upsert(
        {
          org_id: orgId,
          kind: 'trello',
          connection_id: connectionId,
          external_id: board.id,
          display_name: board.name,
          status: 'pending',
          status_message: null,
        },
        { onConflict: 'org_id,external_id' },
      )
      .select('id')
      .single();
    if (upsertErr !== null || row === null) continue;

    await inngest.send({
      name: 'risezome/trello.index-requested',
      data: { orgId, sourceId: row.id as string, reason: 'connect' },
    });
    count += 1;
  }

  revalidatePath('/sources');
  return { ok: true, count };
}
