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
  const errors: string[] = [];
  for (const board of selection) {
    // The Trello uniqueness rule is a PARTIAL unique index
    // (unique (org_id, external_id) WHERE kind = 'trello'), which PostgREST
    // can't use as an `onConflict` arbiter — it errors with 42P10. Resolve
    // the existing row ourselves, then insert-or-update.
    const { data: existing, error: lookupErr } = await service
      .from('sources')
      .select('id')
      .eq('org_id', orgId)
      .eq('kind', 'trello')
      .eq('external_id', board.id)
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
          display_name: board.name,
          status: 'pending',
          status_message: null,
          // Clear the removal tombstone: this action emits its own index
          // event, so re-selecting a removed board is a full revive here.
          removed_at: null,
        })
        .eq('id', existing.id as string)
        .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
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
          kind: 'trello',
          connection_id: connectionId,
          external_id: board.id,
          display_name: board.name,
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
      name: 'risezome/trello.index-requested',
      data: { orgId, sourceId, reason: 'connect', mode: 'full' },
    });
    count += 1;
  }

  revalidatePath('/sources');
  // Surface the real DB error instead of a silent no-op (the old code
  // swallowed upsert failures and returned ok:true with count 0).
  if (count === 0) {
    return { ok: false, error: errors[0] ?? 'No boards were indexed.' };
  }
  return { ok: true, count };
}
