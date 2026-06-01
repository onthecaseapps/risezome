import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fuseRrf, hybridSearch } from '../src/corpus-search.js';
import type { Reranker } from '@risezome/engine/embed';

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
    const out = fuseRrf([{ chunk_id: 'Z', distance: 0.2 }], [], { limit: 3, vectorDistanceFloor: 0.45 });
    expect(out.map((h) => h.chunk_id)).toEqual(['Z']);
  });

  it('drops a vector-only hit beyond the floor (weak-tail noise)', () => {
    const out = fuseRrf([{ chunk_id: 'X', distance: 0.9 }], [], { limit: 3, vectorDistanceFloor: 0.45 });
    expect(out).toEqual([]);
  });

  it('a far vector hit SURVIVES when it also matches lexically', () => {
    // distance 0.9 > floor, but an FTS match makes it eligible.
    const out = fuseRrf(
      [{ chunk_id: 'X', distance: 0.9 }],
      [{ chunk_id: 'X', rank: 0.8 }],
      { limit: 3, vectorDistanceFloor: 0.45 },
    );
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
        name === 'search_corpus_vector' ? { data: vector, error: null } : { data: fts, error: null },
      ),
    from: () => ({
      select: () => ({
        in: (_col: string, ids: string[]) =>
          Promise.resolve({ data: ids.map((id) => ({ chunk_id: id, text: texts[id] ?? '' })), error: null }),
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
      docs.map((_d, i) => ({ index: i, score: i === 2 ? 9 : i === 0 ? 1 : 0 })).sort((a, b) => b.score - a.score);
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
