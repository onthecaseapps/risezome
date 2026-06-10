'use server';

import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { decryptForOrgFromBytea } from '@risezome/crypto';
import { requireTrelloApiKey } from '../../_lib/trello';
import { fetchBoardLists, type TrelloClientOptions } from '../../_lib/trello-client';

/**
 * The distinct open-list names across the boards backing a set of Trello
 * sources, so the filtering editor can offer togglable lists instead of
 * free-text. Admin-gated; resolves the org's Trello token, maps source ids →
 * board ids, and unions each board's lists. Capped so a connection with many
 * boards can't fan out unboundedly.
 */

const MAX_BOARDS = 12;

type Result = { ok: true; lists: string[] } | { ok: false; error: string };

export async function getTrelloListsAction(sourceIds: readonly string[]): Promise<Result> {
  const ids = (sourceIds ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (ids.length === 0) return { ok: true, lists: [] };

  const { orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  // Board ids for these sources (org-scoped, trello only).
  const { data: rows } = await service
    .from('sources')
    .select('external_id')
    .in('id', ids)
    .eq('org_id', orgId)
    .eq('kind', 'trello');
  const boardIds = ((rows ?? []) as Array<{ external_id: string | null }>)
    .map((r) => r.external_id)
    .filter((b): b is string => typeof b === 'string' && b.length > 0)
    .slice(0, MAX_BOARDS);
  if (boardIds.length === 0) return { ok: true, lists: [] };

  // Resolve + decrypt the org's Trello token.
  const { data: conn } = await service
    .from('trello_connections')
    .select('token_enc')
    .eq('org_id', orgId)
    .maybeSingle();
  if (conn === null || conn.token_enc === null) return { ok: false, error: 'trello_not_connected' };

  let trello: TrelloClientOptions;
  try {
    const token = await decryptForOrgFromBytea(orgId, conn.token_enc as Uint8Array);
    trello = { token, apiKey: requireTrelloApiKey() };
  } catch {
    return { ok: false, error: 'token_unavailable' };
  }

  try {
    const perBoard = await Promise.all(boardIds.map((b) => fetchBoardLists(b, trello).catch(() => [] as string[])));
    const distinct = [...new Set(perBoard.flat())].sort((a, b) => a.localeCompare(b));
    return { ok: true, lists: distinct };
  } catch {
    return { ok: false, error: 'fetch_failed' };
  }
}
