'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { removeSourceFromTeam } from '../../_lib/team-source-lifecycle';

type Provider = 'github' | 'trello' | 'jira' | 'confluence';

export interface RemoveConnectionArgs {
  teamId: string;
  provider: Provider;
  /** The card's indexed source ids (items that have a `sources` row). */
  sourceIds: string[];
  /** GitHub only: the installation this card represents. */
  installationId?: number;
}

export type RemoveConnectionResult =
  | {
      ok: true;
      /** The whole connection was disconnected (its credential row removed). */
      fullyRemoved: boolean;
      /** Sources de-indexed because this was the last team using them. */
      deindexed: number;
      /** Sources kept because another team still uses them. */
      keptInUse: number;
    }
  | { ok: false; error: string };

/**
 * Remove a connection's sources from the CURRENT team, reference-count aware.
 *
 * For each of the card's sources, `removeSourceFromTeam` drops the team_sources
 * join row; only when that was the LAST team referencing the source does the
 * source flip to `status='removed'` (the purge cron then de-indexes its corpus).
 * A source still selected by another team is kept and stays indexed.
 *
 * Then the credential connection itself is garbage-collected: only when NOTHING
 * under it is referenced by any team anymore is the connection disconnected (its
 * credential row deleted, so the card disappears). Atlassian shares one
 * credential row across Jira + Confluence, so removing Confluence keeps the
 * connection alive while Jira is still in use.
 *
 * requireAdmin-gated; orgId is resolved server-side and every query is org-scoped.
 */
export async function removeConnectionFromTeamAction(
  args: RemoveConnectionArgs,
): Promise<RemoveConnectionResult> {
  const { teamId, provider, sourceIds, installationId } = args;
  const { orgId } = await requireAdmin();
  try {
    const service = createServiceRoleClient();

    // 1. Keep only the card's sources that actually belong to this org
    //    (defense-in-depth; service-role bypasses RLS).
    let validSourceIds: string[] = [];
    if (sourceIds.length > 0) {
      const { data: rows } = await service
        .from('sources')
        .select('id')
        .in('id', sourceIds)
        .eq('org_id', orgId);
      validSourceIds = (rows ?? []).map((r) => r.id as string);
    }

    // 2. Remove each from this team. De-index happens only on the last team.
    let deindexed = 0;
    let keptInUse = 0;
    for (const sourceId of validSourceIds) {
      const { deindexed: gone } = await removeSourceFromTeam({ orgId, teamId, sourceId });
      if (gone) deindexed += 1;
      else keptInUse += 1;
    }

    // 3. Disconnect the credential connection iff it is now wholly unused.
    const fullyRemoved = await maybeDisconnectCredential(service, { orgId, provider, installationId });

    revalidatePath('/sources');
    return { ok: true, fullyRemoved, deindexed, keptInUse };
  } catch (err) {
    // Surface a clean failure to the UI instead of an unhandled rejection — the
    // per-source removal + credential GC are not transactional, so a mid-flight
    // throw can leave partial state; the caller shows "couldn't remove" and a
    // re-run reconciles (removeSourceFromTeam is idempotent on already-removed).
    console.error('[sources.remove-connection] failed:', err);
    return { ok: false, error: 'remove_failed' };
  }
}

/**
 * Delete the connection's credential row when no source under it is referenced
 * by any team. Returns whether the connection was disconnected.
 */
async function maybeDisconnectCredential(
  service: ReturnType<typeof createServiceRoleClient>,
  { orgId, provider, installationId }: { orgId: string; provider: Provider; installationId: number | undefined },
): Promise<boolean> {
  // Resolve every source id under this credential connection.
  let connSourceIds: string[];
  if (provider === 'github') {
    if (installationId === undefined) return false;
    const { data } = await service
      .from('sources')
      .select('id')
      .eq('org_id', orgId)
      .eq('installation_id', installationId);
    connSourceIds = (data ?? []).map((r) => r.id as string);
  } else {
    // trello / jira / confluence: resolve the per-org credential row, then its
    // sources via the polymorphic connection_id.
    const table = provider === 'trello' ? 'trello_connections' : 'atlassian_connections';
    const { data: conn } = await service.from(table).select('id').eq('org_id', orgId).maybeSingle();
    if (conn === null) return false;
    const { data } = await service
      .from('sources')
      .select('id')
      .eq('org_id', orgId)
      .eq('connection_id', conn.id as string);
    connSourceIds = (data ?? []).map((r) => r.id as string);
  }

  // No source rows under this connection at all → nothing was indexed here, so
  // there is nothing to garbage-collect. Keep the credential: a freshly
  // connected source with only available-but-unindexed items must NOT be torn
  // down (and the Atlassian credential is shared with the other product — a
  // Confluence remove with no sources would otherwise nuke Jira). Only
  // disconnect once sources existed and none remain referenced by any team.
  if (connSourceIds.length === 0) return false;

  // Any of those still referenced by a team → the connection stays.
  const { count } = await service
    .from('team_sources')
    .select('source_id', { count: 'exact', head: true })
    .in('source_id', connSourceIds);
  if ((count ?? 0) > 0) return false;

  // Nothing references it → disconnect.
  if (provider === 'github') {
    // The GitHub App install lives on GitHub; mark the local row removed so the
    // card disappears (page.tsx filters removed_at is null). True uninstall is
    // the "Manage on GitHub" link.
    await service
      .from('github_installations')
      .update({ removed_at: new Date().toISOString() })
      .eq('installation_id', installationId as number)
      .eq('org_id', orgId);
  } else if (provider === 'trello') {
    await service.from('trello_connections').delete().eq('org_id', orgId);
  } else {
    // jira | confluence share one atlassian_connections row (guarded above:
    // reached only when neither product has a referenced source left).
    await service.from('atlassian_connections').delete().eq('org_id', orgId);
  }
  return true;
}
