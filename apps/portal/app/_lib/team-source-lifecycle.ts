import { createServiceRoleClient } from './supabase-server';
import { inngest, type IndexMode } from '../../src/inngest/client';

/**
 * Reference-counted team→source lifecycle (teams restructure U3; KTD4).
 *
 * A source's reference count = the number of teams selecting it (team_sources).
 * These helpers are the single entry/exit points the admin curation actions (U7)
 * call so the index/de-index lifecycle stays in one place:
 *
 *   - addSourceToTeam: insert the join row. If this is the FIRST team to select a
 *     not-yet-indexed (or previously 'removed') source, revive it and emit the
 *     source's kind-specific index event. A second team selecting an already-
 *     indexed source is a join-row insert only — ZERO re-indexing (the corpus is
 *     deduplicated at the source level; "reference what already exists").
 *   - removeSourceFromTeam: delete the join row. If the reference count drops to
 *     ZERO, mark the source 'removed' (+ removed_at). The existing
 *     purge-removed-sources cron hard-deletes its docs/chunks/embeddings after a
 *     grace window; re-adding within the grace window revives it here (the grace
 *     re-check), so a quick remove→re-add never thrashes the index.
 *
 * Service-role (RLS-bypassing) by design — callers (U7) are admin-gated and pass
 * a server-resolved orgId; every query is org_id-scoped as defense-in-depth.
 */

const KIND_EVENT: Record<
  string,
  'risezome/trello.index-requested' | 'risezome/jira.index-requested' | 'risezome/confluence.index-requested'
> = {
  trello: 'risezome/trello.index-requested',
  jira: 'risezome/jira.index-requested',
  confluence: 'risezome/confluence.index-requested',
};

async function emitIndexEvent(orgId: string, sourceId: string, kind: string): Promise<void> {
  const mode: IndexMode = 'full'; // first/revived index does a complete sync
  const kindEvent = KIND_EVENT[kind];
  if (kindEvent !== undefined) {
    await inngest.send({ name: kindEvent, data: { orgId, sourceId, reason: 'reindex', mode } });
  } else {
    await inngest.send({
      name: 'risezome/source.index-requested',
      data: { orgId, sourceId, reason: 'reindex', mode },
    });
  }
}

/** Number of teams currently selecting a source (its reference count). */
async function refcount(
  service: ReturnType<typeof createServiceRoleClient>,
  sourceId: string,
): Promise<number> {
  const { count } = await service
    .from('team_sources')
    .select('source_id', { count: 'exact', head: true })
    .eq('source_id', sourceId);
  return count ?? 0;
}

export interface TeamSourceArgs {
  orgId: string;
  teamId: string;
  sourceId: string;
}

/**
 * Add a source to a team. Idempotent. Triggers indexing only when this brings a
 * not-yet-indexed or previously-removed source into use (first reference).
 * Returns whether an index was kicked off (for the caller's UI/telemetry).
 */
export async function addSourceToTeam(args: TeamSourceArgs): Promise<{ indexed: boolean }> {
  const { orgId, teamId, sourceId } = args;
  const service = createServiceRoleClient();

  // Confirm the source belongs to this org (defense-in-depth; service-role bypasses RLS).
  const { data: source } = await service
    .from('sources')
    .select('id, kind, status, last_indexed_at')
    .eq('id', sourceId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (source === null) {
    throw new Error('source_not_found');
  }

  await service.from('team_sources').insert({ team_id: teamId, source_id: sourceId }).select('source_id');

  const count = await refcount(service, sourceId);
  const neverIndexed = source.last_indexed_at === null;
  const wasRemoved = source.status === 'removed';

  // First reference of a source that needs indexing → revive + index. A second+
  // team selecting an already-indexed source falls through as a no-op.
  if (count >= 1 && (wasRemoved || neverIndexed)) {
    await service
      .from('sources')
      .update({ status: 'pending', status_message: null, removed_at: null })
      .eq('id', sourceId)
      .eq('org_id', orgId);
    await emitIndexEvent(orgId, sourceId, source.kind as string);
    return { indexed: true };
  }
  return { indexed: false };
}

/**
 * Remove a source from a team. When the reference count reaches zero, mark the
 * source 'removed' so the purge cron de-indexes it after the grace window.
 * Returns whether the source was de-indexed (refcount hit zero).
 */
export async function removeSourceFromTeam(args: TeamSourceArgs): Promise<{ deindexed: boolean }> {
  const { orgId, teamId, sourceId } = args;
  const service = createServiceRoleClient();

  await service
    .from('team_sources')
    .delete()
    .eq('team_id', teamId)
    .eq('source_id', sourceId);

  const count = await refcount(service, sourceId);
  if (count === 0) {
    await service
      .from('sources')
      .update({ status: 'removed', removed_at: new Date().toISOString() })
      .eq('id', sourceId)
      .eq('org_id', orgId);
    return { deindexed: true };
  }
  return { deindexed: false };
}
