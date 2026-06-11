// Effective-policy loading for the indexers (U3).
//
// Reads the org-default policy (org_corpus_policy; an absent row means the
// code default, 'recommended') and resolves it against a source's override
// (sources.corpus_policy) into the ready-to-apply EffectiveCorpusPolicy the
// matchers consume. Service-role reads, org-scoped.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveEffectivePolicy,
  type ConnectorOptions,
  type ConnectorRule,
  type CorpusPolicy,
  type EffectiveCorpusPolicy,
  type PresetKey,
  type TeamView,
} from './corpus-policy';

const VALID_PRESETS: ReadonlySet<string> = new Set(['recommended', 'index_everything', 'code_only']);

/**
 * Defensively coerce a stored jsonb value into a CorpusPolicy, or null when it
 * is absent/malformed (null ⇒ inherit, which is the safe default). Never
 * throws — a corrupt override must not break indexing.
 */
export function coerceCorpusPolicy(value: unknown): CorpusPolicy | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['preset'] !== 'string' || !VALID_PRESETS.has(v['preset'])) return null;
  const strArr = (x: unknown): readonly string[] | undefined =>
    Array.isArray(x) && x.every((e) => typeof e === 'string') ? (x as string[]) : undefined;
  // Build with only the keys that are present (exactOptionalPropertyTypes).
  const out: { -readonly [K in keyof CorpusPolicy]?: CorpusPolicy[K] } = { preset: v['preset'] as PresetKey };
  const excludes = strArr(v['customExcludes']);
  if (excludes !== undefined) out.customExcludes = excludes;
  const includes = strArr(v['customIncludes']);
  if (includes !== undefined) out.customIncludes = includes;
  const includeOnly = strArr(v['customIncludeOnly']);
  if (includeOnly !== undefined) out.customIncludeOnly = includeOnly;
  // connectorRules are validated structurally by the matcher; pass through
  // when it's an array, else omit.
  if (Array.isArray(v['connectorRules'])) {
    out.connectorRules = v['connectorRules'] as readonly ConnectorRule[];
  }
  // connectorOptions: only the typed Trello toggle is read.
  const opts = v['connectorOptions'];
  if (opts !== null && typeof opts === 'object') {
    const trello = (opts as Record<string, unknown>)['trello'];
    if (trello !== null && typeof trello === 'object') {
      const inc = (trello as Record<string, unknown>)['includeArchived'];
      if (typeof inc === 'boolean') out.connectorOptions = { trello: { includeArchived: inc } } as ConnectorOptions;
    }
  }
  return out as CorpusPolicy;
}

function rowToCorpusPolicy(row: Record<string, unknown> | null): CorpusPolicy | null {
  if (row === null) return null;
  return coerceCorpusPolicy({
    preset: row['preset'],
    customExcludes: row['custom_excludes'],
    customIncludes: row['custom_includes'],
    connectorRules: row['connector_rules'],
  });
}

/**
 * Resolve the effective corpus policy for a source. `sourceOverride` is the
 * source row's `corpus_policy` jsonb (already loaded by the indexer); pass it
 * raw — coercion happens here.
 */
export async function loadEffectivePolicy(
  db: SupabaseClient,
  orgId: string,
  sourceOverride: unknown,
): Promise<EffectiveCorpusPolicy> {
  const { data } = await db
    .from('org_corpus_policy')
    .select('preset, custom_excludes, custom_includes, connector_rules')
    .eq('org_id', orgId)
    .maybeSingle();
  const orgDefault = rowToCorpusPolicy((data as Record<string, unknown> | null) ?? null);
  return resolveEffectivePolicy(orgDefault, coerceCorpusPolicy(sourceOverride));
}

/**
 * Resolve the per-team VIEW policies for a source — one `TeamView` per team that
 * selects it (`team_sources`), each resolved as org-default → that team's
 * `view_policy`. The indexer uses these to compute the storage union (keep a doc
 * iff ≥1 team admits it) and each doc's `visible_team_ids`. Returns [] when no
 * team selects the source; callers fall back to the single-policy path so a
 * transiently team-less source still indexes under its own policy.
 */
export async function loadTeamViews(
  db: SupabaseClient,
  orgId: string,
  sourceId: string,
): Promise<TeamView[]> {
  const { data: orgRow } = await db
    .from('org_corpus_policy')
    .select('preset, custom_excludes, custom_includes, connector_rules')
    .eq('org_id', orgId)
    .maybeSingle();
  const orgDefault = rowToCorpusPolicy((orgRow as Record<string, unknown> | null) ?? null);

  const { data: tsRows } = await db
    .from('team_sources')
    .select('team_id, view_policy')
    .eq('source_id', sourceId);
  const rows = (tsRows ?? []) as Array<{ team_id: string; view_policy: unknown }>;
  return rows.map((r) => ({
    teamId: r.team_id,
    policy: resolveEffectivePolicy(orgDefault, coerceCorpusPolicy(r.view_policy)),
  }));
}
