// Effective-policy loading for the indexers (U3).
//
// Reads the org-default policy (org_corpus_policy; an absent row means the
// code default, 'recommended') and resolves it against a source's override
// (sources.corpus_policy) into the ready-to-apply EffectiveCorpusPolicy the
// matchers consume. Service-role reads, org-scoped.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveEffectivePolicy,
  type ConnectorRule,
  type CorpusPolicy,
  type EffectiveCorpusPolicy,
  type PresetKey,
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
  // connectorRules are validated structurally by the matcher; pass through
  // when it's an array, else omit.
  if (Array.isArray(v['connectorRules'])) {
    out.connectorRules = v['connectorRules'] as readonly ConnectorRule[];
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
