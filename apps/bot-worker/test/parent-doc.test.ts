import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dedupeByDoc, expandWinnersToParents } from '../src/parent-doc';

/** A Supabase query-builder stub that records .eq() filters and resolves empty. */
function recordingDb(): { db: SupabaseClient; eqCalls: [string, unknown][] } {
  const eqCalls: [string, unknown][] = [];
  const builder = {
    from: () => builder,
    select: () => builder,
    in: () => builder,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return builder;
    },
    then: (resolve: (r: { data: unknown[]; error: null }) => void) =>
      resolve({ data: [], error: null }),
  };
  return { db: builder as unknown as SupabaseClient, eqCalls };
}

describe('expandWinnersToParents org scoping (U11)', () => {
  it('filters the parent-chunk fetch by org_id (defense-in-depth)', async () => {
    const { db, eqCalls } = recordingDb();
    await expandWinnersToParents(db, 'org-123', [
      { chunkId: 'c1', docId: 'd1', position: 0, text: 'hi' },
    ]);
    expect(eqCalls).toContainEqual(['org_id', 'org-123']);
  });
});

describe('dedupeByDoc', () => {
  it('keeps the first (best-ranked) occurrence per docId, preserving order', () => {
    const hits = [
      { id: 'a', doc: 'docA' },
      { id: 'b', doc: 'docB' },
      { id: 'c', doc: 'docA' }, // dup of docA, dropped
      { id: 'd', doc: 'docC' },
      { id: 'e', doc: 'docB' }, // dup of docB, dropped
    ];
    const out = dedupeByDoc(hits, (h) => h.doc);
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'd']);
  });

  it('keeps items whose docId cannot be resolved (undefined)', () => {
    const hits = [
      { id: 'a', doc: undefined },
      { id: 'b', doc: 'docA' },
      { id: 'c', doc: undefined },
      { id: 'd', doc: 'docA' }, // dropped
    ];
    const out = dedupeByDoc(hits, (h) => h.doc);
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when every item is a distinct doc', () => {
    const hits = [
      { id: 'a', doc: 'x' },
      { id: 'b', doc: 'y' },
    ];
    expect(dedupeByDoc(hits, (h) => h.doc)).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupeByDoc([], () => 'x')).toEqual([]);
  });
});
