import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fuseRrf,
  hybridSearch,
  isLowConfidenceHits,
  type HybridHit,
} from '../src/corpus-search.js';
import type { Reranker } from '@risezome/engine/embed';

const hit = (over: Partial<HybridHit>): HybridHit => ({
  chunk_id: 'c',
  distance: null,
  score: 0.01,
  ftsMatched: false,
  ...over,
});

describe('isLowConfidenceHits — CRAG escalation trigger', () => {
  it('is low-confidence on an empty result set (the classic miss)', () => {
    expect(isLowConfidenceHits([])).toBe(true);
  });

  it('is confident when a hit is lexically grounded AND semantically in-range (FTS + distance within the floor)', () => {
    expect(isLowConfidenceHits([hit({ ftsMatched: true, distance: 0.4 })])).toBe(false);
  });

  it('an FTS match ALONE no longer suppresses escalation (keyword-only junk)', () => {
    // A chunk sharing one common token with the question ("issue", "status")
    // is FTS-matched while vectorally distant (or not a vector candidate at
    // all). One such hit used to mark the set confident and suppress CRAG
    // exactly when retrieval was weakest.
    expect(isLowConfidenceHits([hit({ ftsMatched: true, distance: null })])).toBe(true);
    expect(isLowConfidenceHits([hit({ ftsMatched: true, distance: 0.6 })])).toBe(true);
  });

  it('is confident when any hit is a close vector match (<= strong distance)', () => {
    expect(isLowConfidenceHits([hit({ distance: 0.2 })])).toBe(false);
  });

  it('is low-confidence when every hit is a vector-only near-miss beyond strong distance', () => {
    // Distances 0.4 / 0.44 survive the 0.45 relevance floor but clear neither
    // the FTS-grounded nor the close-vector (0.30) bar → worth expanding.
    expect(isLowConfidenceHits([hit({ distance: 0.4 }), hit({ distance: 0.44 })])).toBe(true);
  });

  it('is confident if even one of several hits is strong', () => {
    expect(
      isLowConfidenceHits([
        hit({ distance: 0.44 }),
        hit({ distance: 0.2 }),
        hit({ distance: 0.41 }),
      ]),
    ).toBe(false);
  });
});

describe('fuseRrf — reciprocal rank fusion + relevance floor', () => {
  it('ranks a chunk appearing in BOTH lists above single-list chunks', () => {
    const out = fuseRrf(
      [
        { chunk_id: 'A', distance: 0.1 },
        { chunk_id: 'B', distance: 0.2 },
      ],
      [
        { chunk_id: 'B', rank: 0.9 },
        { chunk_id: 'C', rank: 0.5 },
      ],
      { limit: 3 },
    );
    expect(out.map((h) => h.chunk_id)).toEqual(['B', 'A', 'C']);
    expect(out[0]!.ftsMatched).toBe(true);
    expect(out[0]!.distance).toBe(0.2);
  });

  it('keeps an FTS-only hit (lexically grounded) with null distance', () => {
    const out = fuseRrf([], [{ chunk_id: 'Y', rank: 0.5 }], { limit: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ chunk_id: 'Y', distance: null, ftsMatched: true });
  });

  it('keeps a vector-only hit within the distance floor', () => {
    const out = fuseRrf([{ chunk_id: 'Z', distance: 0.2 }], [], {
      limit: 3,
      vectorDistanceFloor: 0.45,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['Z']);
  });

  it('drops a vector-only hit beyond the floor (weak-tail noise)', () => {
    const out = fuseRrf([{ chunk_id: 'X', distance: 0.9 }], [], {
      limit: 3,
      vectorDistanceFloor: 0.45,
    });
    expect(out).toEqual([]);
  });

  it('a far vector hit SURVIVES when it also matches lexically', () => {
    // distance 0.9 > floor, but an FTS match makes it eligible.
    const out = fuseRrf([{ chunk_id: 'X', distance: 0.9 }], [{ chunk_id: 'X', rank: 0.8 }], {
      limit: 3,
      vectorDistanceFloor: 0.45,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['X']);
    expect(out[0]!.ftsMatched).toBe(true);
  });

  it('lexical match surfaces the right chunk over a closer-but-wrong vector-only neighbor', () => {
    // The retrieval bug in miniature: a wrong chunk is the closest vector
    // neighbor, but the right chunk is found only by keyword. With both a
    // vector and FTS rank, the right chunk fuses higher.
    const out = fuseRrf(
      [
        { chunk_id: 'wrong-but-close', distance: 0.34 },
        { chunk_id: 'right-answer', distance: 0.41 },
      ],
      [{ chunk_id: 'right-answer', rank: 0.95 }],
      { limit: 2, vectorDistanceFloor: 0.45 },
    );
    expect(out[0]!.chunk_id).toBe('right-answer');
  });

  it('respects the limit', () => {
    const out = fuseRrf(
      [
        { chunk_id: 'A', distance: 0.1 },
        { chunk_id: 'B', distance: 0.2 },
        { chunk_id: 'C', distance: 0.3 },
      ],
      [],
      { limit: 2 },
    );
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.chunk_id)).toEqual(['A', 'B']);
  });
});

function mockDb(
  vector: { chunk_id: string; distance: number }[],
  fts: { chunk_id: string; rank: number }[],
  texts: Record<string, string>,
): SupabaseClient {
  return {
    rpc: (name: string) =>
      Promise.resolve(
        name === 'search_corpus_vector'
          ? { data: vector, error: null }
          : { data: fts, error: null },
      ),
    from: () => ({
      select: () => ({
        // U11: the rerank text-fetch now scopes by org_id before .in(chunk_id).
        eq: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({
              data: ids.map((id) => ({ chunk_id: id, text: texts[id] ?? '' })),
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('hybridSearch — reranker integration', () => {
  const vector = [
    { chunk_id: 'A', distance: 0.1 },
    { chunk_id: 'B', distance: 0.2 },
    { chunk_id: 'C', distance: 0.3 },
  ];
  const texts = { A: 'alpha', B: 'beta', C: 'gamma (the real answer)' };

  it('reorders the fused pool by rerank score and truncates to limit', async () => {
    // Rerank pushes C (index 2 in the fused pool) to the top.
    const reranker: Reranker = async (_q, docs) =>
      docs
        .map((_d, i) => ({ index: i, score: i === 2 ? 9 : i === 0 ? 1 : 0 }))
        .sort((a, b) => b.score - a.score);
    const out = await hybridSearch(mockDb(vector, [], texts), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'what is the real answer',
      limit: 2,
      reranker,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['C', 'A']);
  });

  it('keeps RRF order when the reranker throws (graceful degrade)', async () => {
    const reranker: Reranker = async () => {
      throw new Error('rerank 500');
    };
    const out = await hybridSearch(mockDb(vector, [], texts), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 2,
      reranker,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['A', 'B']);
  });

  it('skips reranking entirely when no reranker is supplied', async () => {
    const out = await hybridSearch(mockDb(vector, [], texts), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 2,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['A', 'B']);
  });
});

describe('hybridSearch — U4 effective-source filter', () => {
  // Capturing mock: records the args passed to each RPC so we can assert the
  // p_source_ids the search legs were scoped by.
  function capturingDb(captured: { vector?: unknown; fts?: unknown }): SupabaseClient {
    return {
      rpc: (name: string, args: unknown) => {
        if (name === 'search_corpus_vector') captured.vector = args;
        else captured.fts = args;
        return Promise.resolve({ data: [], error: null });
      },
    } as unknown as SupabaseClient;
  }

  it('passes the source set as p_source_ids to BOTH search legs', async () => {
    const captured: { vector?: unknown; fts?: unknown } = {};
    await hybridSearch(capturingDb(captured), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 5,
      sourceIds: ['s1', 's2'],
    });
    expect((captured.vector as { p_source_ids: string[] }).p_source_ids).toEqual(['s1', 's2']);
    expect((captured.fts as { p_source_ids: string[] }).p_source_ids).toEqual(['s1', 's2']);
  });

  it('passes p_source_ids = null when no source set is given (whole-org corpus)', async () => {
    const captured: { vector?: unknown; fts?: unknown } = {};
    await hybridSearch(capturingDb(captured), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 5,
    });
    expect((captured.vector as { p_source_ids: unknown }).p_source_ids).toBeNull();
    expect((captured.fts as { p_source_ids: unknown }).p_source_ids).toBeNull();
  });

  it('short-circuits to no hits on an EMPTY source set (no DB call)', async () => {
    const captured: { vector?: unknown; fts?: unknown } = {};
    const out = await hybridSearch(capturingDb(captured), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 5,
      sourceIds: [],
    });
    expect(out).toEqual([]);
    expect(captured.vector).toBeUndefined(); // never queried the DB
    expect(captured.fts).toBeUndefined();
  });
});
