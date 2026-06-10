'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest, type IndexMode } from '../../../src/inngest/client';
import { PRESET_KEYS, type PresetKey } from '../../../src/inngest/lib/corpus-policy';

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

/** Set (or clear, when policy is null) a single source's override, then reindex it. */
export async function setSourceCorpusPolicyAction(
  sourceId: string,
  preset: string | null,
): Promise<ActionResult> {
  if (typeof sourceId !== 'string' || sourceId.length === 0) return { ok: false, error: 'missing_source' };
  if (preset !== null && !isValidPreset(preset)) return { ok: false, error: 'invalid_preset' };

  const { orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  // null preset clears the override (inherit org default).
  const override = preset === null ? null : { preset };
  const { data: src, error } = await service
    .from('sources')
    .update({ corpus_policy: override })
    .eq('id', sourceId)
    .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    .neq('status', 'removed') // never reindex a removed source
    .select('id, kind, status')
    .maybeSingle();
  if (error !== null) return { ok: false, error: error.message };
  if (src === null) return { ok: false, error: 'source_not_found' };

  await reindex(orgId, sourceId, (src.kind as string | null) ?? null);
  revalidatePath('/sources');
  return { ok: true, reindexed: 1 };
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
