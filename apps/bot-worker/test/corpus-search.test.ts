import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  fuseRrf,
  fuseRrfMulti,
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

describe('fuseRrfMulti — domain-partitioned vector lists', () => {
  it('ranks each vector list INDEPENDENTLY (a top hit in list 2 is not penalized by list 1 length)', () => {
    // Text-space list ranks T0,T1,T2; code-space list ranks C0. C0 is rank-0 in
    // its OWN list, so it must score like T0 (1/(k+1)), NOT like a 4th-place
    // concatenated item — that's the whole point of independent RRF per space.
    const textList = [
      { chunk_id: 'T0', distance: 0.1 },
      { chunk_id: 'T1', distance: 0.2 },
      { chunk_id: 'T2', distance: 0.3 },
    ];
    const codeList = [{ chunk_id: 'C0', distance: 0.15 }];
    const out = fuseRrfMulti([textList, codeList], [], { limit: 4, rrfK: 60 });
    const score = (id: string) => out.find((h) => h.chunk_id === id)!.score;
    // C0 (rank 0 in its list) ties T0 (rank 0 in its list).
    expect(score('C0')).toBeCloseTo(score('T0'), 10);
    // And beats T1/T2 (ranks 1,2).
    expect(score('C0')).toBeGreaterThan(score('T1'));
  });

  it('a chunk appearing in both a vector list and FTS accumulates both contributions', () => {
    const out = fuseRrfMulti(
      [[{ chunk_id: 'X', distance: 0.1 }]],
      [{ chunk_id: 'X', rank: 0.9 }],
      { limit: 3, rrfK: 60 },
    );
    expect(out[0]!.chunk_id).toBe('X');
    expect(out[0]!.ftsMatched).toBe(true);
    expect(out[0]!.score).toBeCloseTo(2 / 61, 10);
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
  // Distances sit in the WEAK band (above the 0.30 strong bar, below the 0.45
  // floor) and the pool exceeds the limit, so the B2 gate does NOT skip and the
  // reranker's behavior stays under test.
  const vector = [
    { chunk_id: 'A', distance: 0.35 },
    { chunk_id: 'B', distance: 0.38 },
    { chunk_id: 'C', distance: 0.42 },
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

describe('hybridSearch — domain-partitioned dense search (#2b)', () => {
  // Domain-aware mock: returns DIFFERENT vector hits per p_domain so we can
  // prove the code-space query reaches code chunks the text query never sees.
  function domainDb(byDomain: Record<string, { chunk_id: string; distance: number }[]>): SupabaseClient {
    const calls: { domain: string | null; vector: string }[] = [];
    const db = {
      rpc: (name: string, args: { p_domain?: string | null; p_query_vector?: string }) => {
        if (name === 'search_corpus_fts') return Promise.resolve({ data: [], error: null });
        const domain = args.p_domain ?? null;
        calls.push({ domain, vector: args.p_query_vector ?? '' });
        return Promise.resolve({ data: byDomain[domain ?? 'null'] ?? [], error: null });
      },
    } as unknown as SupabaseClient & { __calls: typeof calls };
    (db as unknown as { __calls: typeof calls }).__calls = calls;
    return db;
  }

  it('searches text + code spaces with their OWN query vectors and fuses both', async () => {
    const db = domainDb({
      text: [{ chunk_id: 'DOC', distance: 0.2 }],
      code: [{ chunk_id: 'SRC', distance: 0.15 }],
    });
    const out = await hybridSearch(db, {
      orgId: 'o',
      queryVectorLiteral: '[TEXTVEC]',
      codeQueryVectorLiteral: '[CODEVEC]',
      queryText: 'how does auth work',
      limit: 5,
    });
    // Both the text-space doc AND the code-space source chunk survive — the code
    // chunk is only reachable because the code query vector searched the code
    // partition (a text-only search would have missed it).
    expect(out.map((h) => h.chunk_id).sort()).toEqual(['DOC', 'SRC']);
    const calls = (db as unknown as { __calls: { domain: string | null; vector: string }[] }).__calls;
    expect(calls).toContainEqual({ domain: 'text', vector: '[TEXTVEC]' });
    expect(calls).toContainEqual({ domain: 'code', vector: '[CODEVEC]' });
  });

  it('falls back to a single whole-corpus search when no code vector is given (back-compat)', async () => {
    const db = domainDb({ null: [{ chunk_id: 'X', distance: 0.2 }] });
    const out = await hybridSearch(db, {
      orgId: 'o',
      queryVectorLiteral: '[V]',
      queryText: 'q',
      limit: 5,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['X']);
    const calls = (db as unknown as { __calls: { domain: string | null }[] }).__calls;
    // Exactly one vector search, with NO domain filter.
    expect(calls).toEqual([{ domain: null, vector: '[V]' }]);
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

  it('passes teamIds as p_team_ids to BOTH legs (query-time filtering); null when absent', async () => {
    const withTeams: { vector?: unknown; fts?: unknown } = {};
    await hybridSearch(capturingDb(withTeams), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 5,
      teamIds: ['t1', 't2'],
    });
    expect((withTeams.vector as { p_team_ids: string[] }).p_team_ids).toEqual(['t1', 't2']);
    expect((withTeams.fts as { p_team_ids: string[] }).p_team_ids).toEqual(['t1', 't2']);

    // Absent (flag off) ⇒ null ⇒ the RPC skips the visibility filter.
    const noTeams: { vector?: unknown; fts?: unknown } = {};
    await hybridSearch(capturingDb(noTeams), { orgId: 'o', queryVectorLiteral: '[0]', queryText: 'q', limit: 5 });
    expect((noTeams.vector as { p_team_ids: unknown }).p_team_ids).toBeNull();
    expect((noTeams.fts as { p_team_ids: unknown }).p_team_ids).toBeNull();
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

describe('fuseRrfMulti — per-domain floors (code-distance regression)', () => {
  // voyage-code-3 NL→code distances run higher than text-to-text: the exact
  // answer chunk sits ~0.52 while the text floor is 0.45. Without a per-list
  // floor the entire code leg was discarded ("which embedding model…" found
  // embed/voyage.ts at 0.525 and fusion dropped it).
  it('keeps a code hit above the text floor when its list carries a code floor', () => {
    const hits = fuseRrfMulti(
      [
        [{ chunk_id: 'text-far', distance: 0.52 }], // bare list → default 0.45 floor
        { hits: [{ chunk_id: 'code-answer', distance: 0.525 }], floor: 0.65 },
      ],
      [],
      { limit: 10 },
    );
    const ids = hits.map((h) => h.chunk_id);
    expect(ids).toContain('code-answer'); // within its own 0.65 floor
    expect(ids).not.toContain('text-far'); // still filtered by the text floor
  });

  it('a code hit beyond the code floor is still filtered', () => {
    const hits = fuseRrfMulti(
      [{ hits: [{ chunk_id: 'code-noise', distance: 0.9 }], floor: 0.65 }],
      [],
      { limit: 10 },
    );
    expect(hits).toEqual([]);
  });

  it('a chunk surfacing in both lists passes if either appearance is within its floor', () => {
    const hits = fuseRrfMulti(
      [
        [{ chunk_id: 'both', distance: 0.6 }], // fails text floor
        { hits: [{ chunk_id: 'both', distance: 0.6 }], floor: 0.65 }, // passes code floor
      ],
      [],
      { limit: 10 },
    );
    expect(hits.map((h) => h.chunk_id)).toContain('both');
    expect(hits[0]!.distance).toBe(0.6);
  });

  it('bare arrays keep the legacy default-floor behavior (back-compat)', () => {
    const hits = fuseRrfMulti(
      [[{ chunk_id: 'near', distance: 0.3 }, { chunk_id: 'far', distance: 0.6 }]],
      [],
      { limit: 10 },
    );
    expect(hits.map((h) => h.chunk_id)).toEqual(['near']);
  });
});

describe('enriched RPC returns (C1-lite: zero follow-up round-trips)', () => {
  const enrichedRow = {
    chunk_id: 'A',
    distance: 0.1,
    doc_id: 'doc_1',
    domain: 'text',
    body: 'alpha body',
    chunk_position: 0,
    is_summary: false,
    title: 'Doc One',
    url: 'https://x/1',
    doc_source: 'github',
    doc_type: 'file',
  };

  it('fused hits carry the normalized enrichment from the RPC row', () => {
    const hits = fuseRrf([enrichedRow], [], { limit: 5 });
    expect(hits[0]!.enrich).toEqual({
      docId: 'doc_1',
      domain: 'text',
      body: 'alpha body',
      position: 0,
      isSummary: false,
      title: 'Doc One',
      url: 'https://x/1',
      source: 'github',
      docType: 'file',
    });
  });

  it('hits without enriched fields (mocks / older functions) carry no enrich', () => {
    const hits = fuseRrf([{ chunk_id: 'A', distance: 0.1 }], [], { limit: 5 });
    expect(hits[0]!.enrich).toBeUndefined();
  });

  it('rerank uses carried bodies and NEVER touches the DB when all hits are enriched', async () => {
    let sawBody = '';
    const reranker: Reranker = async (_q, docs) => {
      sawBody = docs[0] ?? '';
      return docs.map((_d, i) => ({ index: i, score: 1 - i * 0.1 }));
    };
    // Weak pool (0.35–0.42) larger than the limit so the B2 gate lets the
    // rerank run; every row enriched so it needs no text fetch.
    const rows = [
      { ...enrichedRow, distance: 0.35, body: 'alpha body' },
      { ...enrichedRow, chunk_id: 'B', distance: 0.38, body: 'beta body', doc_id: 'doc_2' },
      { ...enrichedRow, chunk_id: 'C', distance: 0.42, body: 'gamma body', doc_id: 'doc_3' },
    ];
    const db = {
      rpc: (name: string) =>
        Promise.resolve(
          name === 'search_corpus_vector' ? { data: rows, error: null } : { data: [], error: null },
        ),
      from: () => {
        throw new Error('rerank must not fetch chunk text when bodies are carried');
      },
    } as unknown as SupabaseClient;
    const out = await hybridSearch(db, {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 2,
      reranker,
    });
    expect(out).toHaveLength(2);
    expect(sawBody).toBe('alpha body'); // the carried body reached the cross-encoder
  });
});

describe('B2 rerank gating — skip the cross-encoder when it cannot change the outcome', () => {
  const weakPool = [
    { chunk_id: 'A', distance: 0.35 },
    { chunk_id: 'B', distance: 0.38 },
    { chunk_id: 'C', distance: 0.42 },
  ];

  it('skips rerank when the fused pool is no bigger than the limit (reorder-only)', async () => {
    const reranker: Reranker = async () => {
      throw new Error('reranker must not be called for a pool <= limit');
    };
    const timings: Record<string, number> = {};
    const out = await hybridSearch(mockDb(weakPool, [], {}), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 5, // pool of 3 <= limit 5
      reranker,
      timings,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['A', 'B', 'C']); // RRF order stands
    expect(timings.rerankSkipped).toBe(1);
    expect(timings.rerankMs).toBeUndefined();
  });

  it('skips rerank when the RRF head is already confident (strong vector match)', async () => {
    const reranker: Reranker = async () => {
      throw new Error('reranker must not be called for a confident head');
    };
    const timings: Record<string, number> = {};
    const strongHead = [
      { chunk_id: 'S', distance: 0.12 }, // <= 0.30 strong bar
      ...weakPool,
    ];
    const out = await hybridSearch(mockDb(strongHead, [], {}), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 2, // pool of 4 > limit, but the head is strong
      reranker,
      timings,
    });
    expect(out.map((h) => h.chunk_id)).toEqual(['S', 'A']);
    expect(timings.rerankSkipped).toBe(1);
  });

  it('still reranks a weak head with a pool larger than the limit', async () => {
    let called = false;
    const reranker: Reranker = async (_q, docs) => {
      called = true;
      return docs.map((_d, i) => ({ index: i, score: 1 - i * 0.1 }));
    };
    const timings: Record<string, number> = {};
    await hybridSearch(mockDb(weakPool, [], { A: 'a', B: 'b', C: 'c' }), {
      orgId: 'o',
      queryVectorLiteral: '[0]',
      queryText: 'q',
      limit: 2, // pool of 3 > limit 2, all weak
      reranker,
      timings,
    });
    expect(called).toBe(true);
    expect(timings.rerankMs).toBeTypeOf('number');
    expect(timings.rerankSkipped).toBeUndefined();
  });
});
