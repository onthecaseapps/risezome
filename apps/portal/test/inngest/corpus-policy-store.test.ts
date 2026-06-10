import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEffectivePolicy, coerceCorpusPolicy } from '../../src/inngest/lib/corpus-policy-store';
import { makePathFilter } from '../../src/inngest/lib/corpus-policy';

/** Minimal supabase stub returning a fixed org_corpus_policy row. */
function dbWithOrgRow(row: Record<string, unknown> | null): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: row, error: null }) };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe('coerceCorpusPolicy', () => {
  it('returns null for absent or malformed values', () => {
    expect(coerceCorpusPolicy(null)).toBeNull();
    expect(coerceCorpusPolicy('nope')).toBeNull();
    expect(coerceCorpusPolicy({})).toBeNull();
    expect(coerceCorpusPolicy({ preset: 'bogus' })).toBeNull();
  });

  it('parses a valid override', () => {
    const p = coerceCorpusPolicy({ preset: 'index_everything', customExcludes: ['a/**'] });
    expect(p?.preset).toBe('index_everything');
    expect(p?.customExcludes).toEqual(['a/**']);
  });

  it('drops non-string-array custom fields defensively', () => {
    const p = coerceCorpusPolicy({ preset: 'recommended', customExcludes: [1, 2] });
    expect(p?.customExcludes).toBeUndefined();
  });
});

describe('loadEffectivePolicy', () => {
  it('falls back to recommended when no org row and no override', async () => {
    const eff = await loadEffectivePolicy(dbWithOrgRow(null), 'org1', null);
    expect(makePathFilter(eff)('apps/x/test/a.test.ts')).toBe(false);
    expect(makePathFilter(eff)('src/a.ts')).toBe(true);
  });

  it('honors the org-default preset', async () => {
    const eff = await loadEffectivePolicy(
      dbWithOrgRow({ preset: 'index_everything', custom_excludes: [], custom_includes: [], connector_rules: [] }),
      'org1',
      null,
    );
    expect(makePathFilter(eff)('apps/x/test/a.test.ts')).toBe(true); // nothing excluded
  });

  it('per-source override beats the org default', async () => {
    const eff = await loadEffectivePolicy(
      dbWithOrgRow({ preset: 'recommended', custom_excludes: [], custom_includes: [], connector_rules: [] }),
      'org1',
      { preset: 'index_everything' },
    );
    expect(makePathFilter(eff)('apps/x/test/a.test.ts')).toBe(true);
  });

  it('layers org custom excludes onto the resolved policy', async () => {
    const eff = await loadEffectivePolicy(
      dbWithOrgRow({ preset: 'recommended', custom_excludes: ['vendor/**'], custom_includes: [], connector_rules: [] }),
      'org1',
      null,
    );
    expect(makePathFilter(eff)('vendor/lib.ts')).toBe(false);
    expect(makePathFilter(eff)('src/a.ts')).toBe(true);
  });
});
