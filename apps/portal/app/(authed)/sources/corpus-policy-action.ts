'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest, type IndexMode } from '../../../src/inngest/client';
import { PRESET_KEYS, type CorpusPolicy, type PresetKey } from '../../../src/inngest/lib/corpus-policy';
import { coerceCorpusPolicy } from '../../../src/inngest/lib/corpus-policy-store';

/**
 * Admin-gated corpus-policy edits (U6). Persists the org default or a per-source
 * override (service-role writes — the tables have no client write policy), then
 * reindexes the affected source(s) in `full` mode so the new policy's exclusions
 * are pruned through reconcile (KTD5). A per-source change reindexes that source;
 * an org-default change reindexes every source that has no override.
 */

type ActionResult = { ok: true; reindexed: number } | { ok: false; error: string };

const KIND_EVENT: Record<string, string> = {
  github: 'risezome/source.index-requested',
  trello: 'risezome/trello.index-requested',
  jira: 'risezome/jira.index-requested',
  confluence: 'risezome/confluence.index-requested',
};

function eventForKind(kind: string | null): string {
  return (kind !== null && kind in KIND_EVENT ? KIND_EVENT[kind] : 'risezome/source.index-requested') as string;
}

async function reindex(orgId: string, sourceId: string, kind: string | null): Promise<void> {
  const mode: IndexMode = 'full'; // full so the policy's now-excluded items prune
  await inngest.send({ name: eventForKind(kind), data: { orgId, sourceId, reason: 'reindex', mode } });
}

function isValidPreset(value: unknown): value is PresetKey {
  return typeof value === 'string' && (PRESET_KEYS as readonly string[]).includes(value);
}

/**
 * Validate an incoming per-source override. `null` clears the override
 * (inherit org default). A non-null policy must carry a known preset; the
 * remaining custom rules/patterns/options are coerced (malformed sub-fields
 * dropped) so a bad client payload can't poison the stored policy.
 */
function validateOverride(policy: unknown): { ok: true; value: CorpusPolicy | null } | { ok: false } {
  if (policy === null || policy === undefined) return { ok: true, value: null };
  if (!isValidPreset((policy as { preset?: unknown }).preset)) return { ok: false };
  return { ok: true, value: coerceCorpusPolicy(policy) };
}

/**
 * Apply a per-source override (a full custom CorpusPolicy, or null to inherit)
 * to one or more sources, then reindex each. The card-level filtering control
 * passes all of a connection's source ids; a single-source override passes one.
 */
export async function setSourcesCorpusPolicyAction(
  sourceIds: readonly string[],
  policy: CorpusPolicy | null,
): Promise<ActionResult> {
  const ids = (sourceIds ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (ids.length === 0) return { ok: false, error: 'missing_source' };
  const validated = validateOverride(policy);
  if (!validated.ok) return { ok: false, error: 'invalid_preset' };

  const { orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  const { data: rows, error } = await service
    .from('sources')
    .update({ corpus_policy: validated.value })
    .in('id', ids)
    .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    .neq('status', 'removed') // never reindex a removed source
    .select('id, kind');
  if (error !== null) return { ok: false, error: error.message };

  const updated = (rows ?? []) as Array<{ id: string; kind: string | null }>;
  await Promise.all(updated.map((s) => reindex(orgId, s.id, s.kind)));
  revalidatePath('/sources');
  return { ok: true, reindexed: updated.length };
}

/** Set the org-default policy, then reindex every source that has no override. */
export async function setOrgCorpusPolicyAction(preset: string): Promise<ActionResult> {
  if (!isValidPreset(preset)) return { ok: false, error: 'invalid_preset' };

  const { orgId, user } = await requireAdmin();
  const service = createServiceRoleClient();

  const { error } = await service.from('org_corpus_policy').upsert(
    { org_id: orgId, preset, updated_by: user.id, updated_at: new Date().toISOString() },
    { onConflict: 'org_id' },
  );
  if (error !== null) return { ok: false, error: error.message };

  // Reindex sources that inherit the org default (no per-source override) and
  // aren't removed.
  const { data: sources } = await service
    .from('sources')
    .select('id, kind')
    .eq('org_id', orgId)
    .is('corpus_policy', null)
    .neq('status', 'removed');
  const rows = (sources ?? []) as Array<{ id: string; kind: string | null }>;
  await Promise.all(rows.map((s) => reindex(orgId, s.id, s.kind)));

  revalidatePath('/sources');
  return { ok: true, reindexed: rows.length };
}
