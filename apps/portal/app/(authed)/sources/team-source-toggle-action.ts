'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { addSourceToTeam, removeSourceFromTeam } from '../../_lib/team-source-lifecycle';

/**
 * Per-team item-toggle action — the single seam wiring a Sources-page checklist
 * item to the shipped `team_sources` refcount lifecycle (KTD2/KTD3).
 *
 * Checking an item adds the source to the selected team (first reference indexes
 * via the lifecycle); unchecking removes it (last drop de-indexes via the purge
 * cron). The provider-specific part is "ensure the `sources` row exists":
 *
 *   - GitHub: the install-callback already created a `sources` row per granted
 *     repo, so the row exists — we resolve its id by (installation_id,
 *     repo_full_name) and add. No new source row.
 *   - Trello / Jira / Confluence: a board/project/space becomes a `sources` row
 *     only on select. We ensure it (upsert by (org_id, external_id[, kind]))
 *     exactly as the existing trello-/atlassian-select actions do, then add.
 *
 * Off (any provider): resolve the source id and removeSourceFromTeam — we never
 * hard-delete the `sources` row here; the lifecycle/purge cron owns de-index.
 *
 * requireAdmin-gated; orgId is resolved server-side and every query is org-scoped.
 */

type Provider = 'github' | 'trello' | 'jira' | 'confluence';

export interface ToggleItemArgs {
  teamId: string;
  provider: Provider;
  /** GitHub: repo_full_name. Trello/Jira/Confluence: the external id (board id,
   *  project key, space id). */
  externalId: string;
  /** Display label, used when ensuring a new Trello/Atlassian source row. */
  label: string;
  /** GitHub only: which installation this repo belongs to (disambiguates repos
   *  with the same full name across installations — defensive). */
  installationId?: number | undefined;
  on: boolean;
}

type ActionResult = { ok: true } | { ok: false; error: string };

const ATLASSIAN_KINDS: ReadonlySet<string> = new Set(['jira', 'confluence']);

export async function setItemForTeamAction(args: ToggleItemArgs): Promise<ActionResult> {
  const { teamId, provider, externalId, label, installationId, on } = args;
  const { orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  try {
    const sourceId = on
      ? await ensureSourceId({ service, orgId, provider, externalId, label, installationId })
      : await resolveSourceId({ service, orgId, provider, externalId, installationId });

    if (sourceId === null) {
      return { ok: false, error: 'source_not_found' };
    }

    if (on) {
      await addSourceToTeam({ orgId, teamId, sourceId });
    } else {
      await removeSourceFromTeam({ orgId, teamId, sourceId });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'toggle_failed' };
  }

  revalidatePath('/sources');
  return { ok: true };
}

type Service = ReturnType<typeof createServiceRoleClient>;

interface ResolveArgs {
  service: Service;
  orgId: string;
  provider: Provider;
  externalId: string;
  installationId?: number | undefined;
}

/**
 * Resolve an existing source row's id for an item, or null if none exists.
 * GitHub keys on (installation_id, repo_full_name); Trello/Atlassian on
 * (org_id, kind, external_id).
 */
async function resolveSourceId(args: ResolveArgs): Promise<string | null> {
  const { service, orgId, provider, externalId, installationId } = args;

  if (provider === 'github') {
    let query = service
      .from('sources')
      .select('id')
      .eq('org_id', orgId)
      .eq('repo_full_name', externalId);
    if (installationId !== undefined) {
      query = query.eq('installation_id', installationId);
    }
    const { data } = await query.maybeSingle();
    return data !== null ? (data.id as string) : null;
  }

  const { data } = await service
    .from('sources')
    .select('id')
    .eq('org_id', orgId)
    .eq('kind', provider)
    .eq('external_id', externalId)
    .maybeSingle();
  return data !== null ? (data.id as string) : null;
}

interface EnsureArgs extends ResolveArgs {
  label: string;
}

/**
 * Ensure a source row exists for the item and return its id.
 *
 * GitHub repos are pre-created at install, so this is just a resolve (a missing
 * row means the repo isn't granted — surfaced as source_not_found). Trello/Jira/
 * Confluence rows are created on first select; we upsert by (org_id, kind,
 * external_id), mirroring the select actions (resolve-then-insert-or-update,
 * because the partial-unique index can't be a PostgREST onConflict arbiter).
 */
async function ensureSourceId(args: EnsureArgs): Promise<string | null> {
  const { service, orgId, provider, externalId, label, installationId } = args;

  if (provider === 'github') {
    return resolveSourceId({ service, orgId, provider, externalId, installationId });
  }

  if (!ATLASSIAN_KINDS.has(provider) && provider !== 'trello') {
    return null;
  }

  // Resolve the org's connection so the new row binds to it (matches the select
  // actions' connection_id wiring).
  const connectionTable = provider === 'trello' ? 'trello_connections' : 'atlassian_connections';
  const { data: conn } = await service
    .from(connectionTable)
    .select('id')
    .eq('org_id', orgId)
    .maybeSingle();
  if (conn === null) {
    throw new Error(provider === 'trello' ? 'trello_not_connected' : 'atlassian_not_connected');
  }
  const connectionId = conn.id as string;

  const existingId = await resolveSourceId({ service, orgId, provider, externalId });
  if (existingId !== null) {
    // Refresh metadata ONLY — do not touch status here. Stomping status to
    // 'pending' before addSourceToTeam runs blinded reviveSource's
    // wasRemoved check (it saw 'pending', concluded no revive was needed,
    // and never cleared removed_at or emitted the reindex event), leaving
    // re-selected boards stuck on stale content. The lifecycle owns status.
    const { error } = await service
      .from('sources')
      .update({ connection_id: connectionId, display_name: label })
      .eq('id', existingId)
      .eq('org_id', orgId);
    if (error !== null) throw new Error(error.message);
    return existingId;
  }

  const { data: row, error: insertErr } = await service
    .from('sources')
    .insert({
      org_id: orgId,
      kind: provider,
      connection_id: connectionId,
      external_id: externalId,
      display_name: label,
      status: 'pending',
      status_message: null,
    })
    .select('id')
    .single();
  if (insertErr !== null || row === null) {
    throw new Error(insertErr?.message ?? 'source insert returned no row');
  }
  return row.id as string;
}
