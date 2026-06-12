import type { SupabaseClient } from '@supabase/supabase-js';
import type { Reranker } from '@risezome/engine/embed';

/**
 * Hybrid corpus retrieval: dense (pgvector cosine) + lexical (Postgres
 * full-text) fused with Reciprocal Rank Fusion, then gated by a relevance
 * floor.
 *
 * Why hybrid: pure vector search on a short, vague utterance ("what ai
 * models are used") embeds to a fuzzy point, so spurious near-neighbors can
 * outrank the chunks that literally answer the question. Lexical search
 * anchors on the actual nouns ("models"), surfacing those chunks; RRF blends
 * the two rankings without needing the two scores to be on the same scale.
 *
 * Relevance floor: a vector-only candidate (no lexical match) must be within
 * `vectorDistanceFloor` to be eligible. FTS matches are always eligible
 * (they are lexically grounded). This drops the weak-tail noise that pure
 * top-K-no-floor surfaced, and lets a genuinely-irrelevant query return
 * nothing (so synthesis declines) instead of the K least-bad chunks.
 */

const DEFAULT_CANDIDATE_LIMIT = 20;
const DEFAULT_RRF_K = 60;
// Cosine distance (0 = identical, 2 = opposite). voyage-3-large: a strong
// match sits well under 0.3; beyond ~0.45 a vector-only hit is weak enough
// that, absent a lexical match, it's more likely noise than signal.
const DEFAULT_VECTOR_DISTANCE_FLOOR = 0.45;

// voyage-code-3 cross-modal (NL query → code chunk) distances run HIGHER than
// voyage-3-large text-to-text: an exact-answer code chunk sits ~0.52 (observed:
// "which embedding model…" → embed/voyage.ts at 0.525), noise ~0.9. The text
// floor (0.45) silently discarded every code-domain hit — the partitioned code
// leg retrieved perfectly and fusion threw it all away.
const DEFAULT_CODE_VECTOR_DISTANCE_FLOOR = 0.65;

function envFloor(): number {
  const raw = process.env.RISEZOME_VECTOR_DISTANCE_FLOOR;
  if (raw === undefined) return DEFAULT_VECTOR_DISTANCE_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VECTOR_DISTANCE_FLOOR;
}

function envCodeFloor(): number {
  const raw = process.env.RISEZOME_CODE_VECTOR_DISTANCE_FLOOR;
  if (raw === undefined) return DEFAULT_CODE_VECTOR_DISTANCE_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CODE_VECTOR_DISTANCE_FLOOR;
}

// CRAG escalation (U10 close-out): a "strong" hit is one that is lexically
// grounded (FTS-matched) or a close vector match (distance <= this). When the
// result set contains no strong hit, the first pass is low-confidence — worth
// a CRAG expansion even though it wasn't a total miss, so a scattered query
// that pulled one mediocre vector-only chunk still escalates to the richer
// path instead of synthesizing a thin answer. Sits below the 0.45 relevance
// floor: hits between strong-distance and floor survive retrieval but are weak
// enough to be worth a second look. Tunable via RISEZOME_CRAG_STRONG_DISTANCE.
const DEFAULT_CRAG_STRONG_DISTANCE = 0.3;

function strongDistance(): number {
  const raw = process.env.RISEZOME_CRAG_STRONG_DISTANCE;
  if (raw === undefined) return DEFAULT_CRAG_STRONG_DISTANCE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CRAG_STRONG_DISTANCE;
}

/**
 * Is this hybrid-search result set low-confidence (worth a CRAG expansion)?
 * True when there are no hits, or when no hit is "strong". A hit is strong when
 * it's a close vector match (distance <= strongDistance()), or it's lexically
 * grounded (FTS-matched) AND at least semantically in-range (distance within
 * the relevance floor).
 *
 * An FTS match ALONE no longer counts as strong: websearch_to_tsquery ORs the
 * query's terms, so a chunk sharing ONE common token ("issue", "status") with
 * the question is "FTS-matched" while being vectorally distant junk — and one
 * such hit used to mark the whole set confident, suppressing the CRAG retry
 * exactly when the retrieval was weakest. Lexically-grounded hits remain
 * ELIGIBLE to surface (the fuseRrf floor is unchanged); they just don't
 * suppress escalation unless the vector leg also puts them in range.
 */
export function isLowConfidenceHits(hits: readonly HybridHit[]): boolean {
  if (hits.length === 0) return true;
  const strong = strongDistance();
  const floor = envFloor();
  return !hits.some(
    (h) =>
      (h.distance !== null && h.distance <= strong) ||
      (h.ftsMatched && h.distance !== null && h.distance <= floor),
  );
}

export interface VectorCandidate {
  readonly chunk_id: string;
  readonly distance: number;
}
export interface FtsCandidate {
  readonly chunk_id: string;
  readonly rank: number;
}

export interface HybridHit {
  readonly chunk_id: string;
  /** Cosine distance when the chunk was a vector candidate; null for an
   *  FTS-only hit (no vector rank within the candidate pool). */
  readonly distance: number | null;
  /** Fused RRF score (higher is better). */
  readonly score: number;
  /** Whether the chunk matched the lexical (full-text) query. */
  readonly ftsMatched: boolean;
}

export interface FuseOptions {
  readonly limit: number;
  readonly rrfK?: number;
  readonly vectorDistanceFloor?: number;
}

/** A vector list with its own relevance floor (per-domain: text vs code
 *  distances aren't comparable). Bare arrays use the default floor. */
export interface FlooredVectorList {
  readonly hits: readonly VectorCandidate[];
  readonly floor?: number;
}

export type VectorListInput = readonly VectorCandidate[] | FlooredVectorList;

/**
 * Pure RRF fusion + floor. Separated from the DB calls so it can be unit
 * tested. `vector` is ordered best-first by ascending distance; `fts` is
 * ordered best-first by descending ts_rank (both as returned by the RPCs).
 */
export function fuseRrf(
  vector: readonly VectorCandidate[],
  fts: readonly FtsCandidate[],
  opts: FuseOptions,
): HybridHit[] {
  return fuseRrfMulti([vector], fts, opts);
}

/**
 * RRF fusion over MULTIPLE independently-ranked vector lists + FTS list(s).
 * Each list contributes `1/(k + rank_within_that_list)` — critical because (a)
 * the domain-partitioned text-space (voyage-3-large) and code-space
 * (voyage-code-3) lists have NON-comparable distances and each must keep its own
 * rank, and (b) MULTI-QUERY retrieval adds one list per sub-query and each
 * sub-query's ranking is independent. A chunk can appear in several lists (e.g.
 * surfaced by both the primary and an expansion query) and accumulates each
 * contribution. The floor uses whichever vector distance the candidate carries
 * (FTS-only always passes). Accepts either a single FTS list or several.
 */
export function fuseRrfMulti(
  vectorLists: readonly VectorListInput[],
  fts: readonly FtsCandidate[] | readonly (readonly FtsCandidate[])[],
  opts: FuseOptions,
): HybridHit[] {
  const k = opts.rrfK ?? DEFAULT_RRF_K;
  const defaultFloor = opts.vectorDistanceFloor ?? envFloor();

  const byId = new Map<
    string,
    { distance: number | null; ftsMatched: boolean; score: number; passesFloor: boolean }
  >();
  const get = (id: string) => {
    let e = byId.get(id);
    if (e === undefined) {
      e = { distance: null, ftsMatched: false, score: 0, passesFloor: false };
      byId.set(id, e);
    }
    return e;
  };

  for (const input of vectorLists) {
    const list = Array.isArray(input) ? (input as readonly VectorCandidate[]) : (input as FlooredVectorList).hits;
    const listFloor = Array.isArray(input)
      ? defaultFloor
      : ((input as FlooredVectorList).floor ?? defaultFloor);
    list.forEach((row, i) => {
      const e = get(row.chunk_id);
      // Keep the BEST (lowest) distance for reporting; a candidate passes the
      // floor if ANY of its appearances was within that list's own floor.
      e.distance = e.distance === null ? row.distance : Math.min(e.distance, row.distance);
      e.passesFloor = e.passesFloor || row.distance <= listFloor;
      e.score += 1 / (k + i + 1);
    });
  }
  // Normalize fts to a list-of-lists (a single list is wrapped once).
  const ftsLists: readonly (readonly FtsCandidate[])[] =
    fts.length > 0 && Array.isArray((fts as readonly unknown[])[0])
      ? (fts as readonly (readonly FtsCandidate[])[])
      : [fts as readonly FtsCandidate[]];
  for (const list of ftsLists) {
    list.forEach((row, i) => {
      const e = get(row.chunk_id);
      e.ftsMatched = true;
      e.score += 1 / (k + i + 1);
    });
  }

  return (
    [...byId.entries()]
      // Floor: lexical matches always pass; vector-only must have been close
      // enough within at least one list's own (per-domain) floor.
      .filter(([, e]) => e.ftsMatched || e.passesFloor)
      .map(([chunk_id, e]) => ({
        chunk_id,
        distance: e.distance,
        score: e.score,
        ftsMatched: e.ftsMatched,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
  );
}

export interface HybridSearchParams {
  readonly orgId: string;
  /** pgvector literal of the TEXT-space query (voyage-3-large): `[0.1,0.2,...]`. */
  readonly queryVectorLiteral: string;
  /** pgvector literal of the CODE-space query (voyage-code-3). When set, the
   *  dense leg is PARTITIONED: text chunks are searched with `queryVectorLiteral`
   *  and code chunks with this, each within its own model's space (the two
   *  spaces aren't distance-comparable). When omitted, the legacy single-vector
   *  search runs over all chunks (back-compat for eval/debug callers). */
  readonly codeQueryVectorLiteral?: string | undefined;
  /** Natural-ish text for websearch_to_tsquery (the rolling window). */
  readonly queryText: string;
  /** Focused query for the cross-encoder reranker. The FTS `queryText` can be
   *  a whole rolling window (ambient lane) — scoring documents against that
   *  multi-topic blob dilutes the reranker's precision. When set, the reranker
   *  scores against THIS (e.g. the question utterance) while FTS keeps the
   *  broader text. Defaults to `queryText`. */
  readonly rerankQuery?: string;
  readonly limit: number;
  readonly candidateLimit?: number;
  /** The meeting's effective source set (teams restructure U4): the union of its
   *  attendees' teams' sources. Restricts both the vector and FTS legs to these
   *  sources. `undefined` ⇒ no source filter (whole-org corpus, e.g. the debug
   *  page). An EMPTY array ⇒ no in-scope sources ⇒ no corpus hits. */
  readonly sourceIds?: readonly string[];
  /** Query-time per-team filter: the meeting's attending teams. A chunk is
   *  returned only if its `visible_team_ids` overlaps this set. `undefined` ⇒
   *  no team filter (today's behavior; flag-gated upstream). */
  readonly teamIds?: readonly string[];
  /** Optional cross-encoder reranker (U4). When set, the fused candidate
   *  pool is reranked by query-document relevance and truncated to `limit`;
   *  on any rerank error the RRF order is kept (graceful degrade). */
  readonly reranker?: Reranker | undefined;
  /** MULTI-QUERY retrieval (proactive, for scattered/overview questions): extra
   *  query variants whose candidate pools are UNIONED with the primary BEFORE a
   *  single rerank against `rerankQuery`. Each adds its own independently-ranked
   *  vector list(s) + FTS list to the fusion (broader recall), and the rerank
   *  against the original question restores precision. Empty/omitted ⇒ the
   *  single-query path. */
  readonly expansionQueries?: readonly {
    readonly queryVectorLiteral: string;
    readonly codeQueryVectorLiteral?: string;
    readonly queryText: string;
  }[] | undefined;
  readonly logger?: { warn: (obj: object, msg?: string) => void };
  /** Optional timing collector (debug/trace only): filled with internal phase
   *  durations (`rpcMs` = all vector+FTS RPC legs, `rerankMs` = chunk-text
   *  fetch + cross-encoder) so the trace can split the search stage's latency.
   *  Mutated in place; omit in prod (zero cost). */
  readonly timings?: Record<string, number> | undefined;
}

/** Fused candidates fetched for reranking before the final top-K cut. */
const RERANK_POOL = 25;

/**
 * Run vector + FTS in parallel and fuse. If FTS errors (or the query text
 * tokenizes to nothing), degrade gracefully to vector-only so retrieval
 * never hard-fails on the lexical leg. A vector error propagates as an empty
 * result (the caller treats no hits as a skip), matching prior behavior.
 */
export async function hybridSearch(
  db: SupabaseClient,
  params: HybridSearchParams,
): Promise<HybridHit[]> {
  const candidateLimit = params.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;

  // U4: an empty (but defined) source set means the meeting's attendees' teams
  // select nothing — short-circuit to no hits without touching the DB.
  if (params.sourceIds?.length === 0) {
    return [];
  }
  // `null` p_source_ids ⇒ the RPC skips the source filter (whole-org corpus).
  const pSourceIds = params.sourceIds === undefined ? null : [...params.sourceIds];
  // `null` p_team_ids ⇒ the RPC skips the per-team visibility filter.
  const pTeamIds = params.teamIds === undefined ? null : [...params.teamIds];

  const vectorRpc = (queryVectorLiteral: string, pDomain: string | null) =>
    db.rpc('search_corpus_vector', {
      p_org_id: params.orgId,
      p_query_vector: queryVectorLiteral,
      p_limit: candidateLimit,
      p_source_ids: pSourceIds,
      p_domain: pDomain,
      p_team_ids: pTeamIds,
    }) as unknown as Promise<{ data: VectorCandidate[] | null; error: { message: string } | null }>;
  const ftsRpc = (queryText: string) =>
    db.rpc('search_corpus_fts', {
      p_org_id: params.orgId,
      p_query: queryText,
      p_limit: candidateLimit,
      p_source_ids: pSourceIds,
      p_team_ids: pTeamIds,
    }) as unknown as Promise<{ data: FtsCandidate[] | null; error: { message: string } | null }>;

  // One query variant → its vector list(s) [text(+code) partition] + its FTS
  // list. Partitioned dense search runs only when a code-space vector is given.
  const runQuery = async (q: {
    queryVectorLiteral: string;
    codeQueryVectorLiteral?: string;
    queryText: string;
  }): Promise<{ vectorLists: FlooredVectorList[]; fts: FtsCandidate[]; vectorFailed: boolean }> => {
    const partitioned = q.codeQueryVectorLiteral !== undefined;
    const [textVecRes, codeVecRes, ftsRes] = await Promise.all([
      vectorRpc(q.queryVectorLiteral, partitioned ? 'text' : null),
      partitioned
        ? vectorRpc(q.codeQueryVectorLiteral!, 'code')
        : Promise.resolve({ data: [] as VectorCandidate[], error: null }),
      ftsRpc(q.queryText),
    ]);
    if (textVecRes.error !== null) {
      params.logger?.warn({ err: textVecRes.error }, 'corpus-search.vector.failed');
      return { vectorLists: [], fts: [], vectorFailed: true };
    }
    if (codeVecRes.error !== null) {
      params.logger?.warn({ err: codeVecRes.error }, 'corpus-search.vector.code.failed');
    }
    if (ftsRes.error !== null) {
      params.logger?.warn({ err: ftsRes.error }, 'corpus-search.fts.failed');
    }
    const vectorLists: FlooredVectorList[] = [{ hits: textVecRes.data ?? [], floor: envFloor() }];
    if (codeVecRes.error === null && (codeVecRes.data?.length ?? 0) > 0) {
      // Code-space distances run higher; without the code floor the whole
      // code leg is discarded by the text-calibrated default.
      vectorLists.push({ hits: codeVecRes.data ?? [], floor: envCodeFloor() });
    }
    return { vectorLists, fts: ftsRes.error === null ? (ftsRes.data ?? []) : [], vectorFailed: false };
  };

  // Run the primary query + any expansion variants concurrently; union their
  // candidate pools (each list keeps its own RRF rank) before a single rerank.
  const queries = [
    {
      queryVectorLiteral: params.queryVectorLiteral,
      ...(params.codeQueryVectorLiteral !== undefined
        ? { codeQueryVectorLiteral: params.codeQueryVectorLiteral }
        : {}),
      queryText: params.queryText,
    },
    ...(params.expansionQueries ?? []),
  ];
  const rpcStart = Date.now();
  const results = await Promise.all(queries.map(runQuery));
  if (params.timings !== undefined) params.timings.rpcMs = Date.now() - rpcStart;
  // The PRIMARY query's dense leg failing hard-fails (matches prior behavior);
  // an expansion's failure just contributes nothing.
  if (results[0]!.vectorFailed) return [];
  const allVectorLists = results.flatMap((r) => r.vectorLists);
  const allFtsLists = results.map((r) => r.fts);

  const fused = fuseRrfMulti(allVectorLists, allFtsLists, {
    // With a reranker, fuse to a larger pool and let the cross-encoder pick
    // the final top-`limit`; otherwise fuse straight to `limit`.
    limit: params.reranker !== undefined ? RERANK_POOL : params.limit,
  });

  if (params.reranker === undefined || fused.length <= 1) {
    return fused.slice(0, params.limit);
  }

  // Rerank the pool by query-document relevance. Fetch the verbatim chunk
  // bodies (what a reader sees) for the cross-encoder; on any failure keep
  // the RRF order.
  const rerankStart = Date.now();
  const stampRerank = (): void => {
    if (params.timings !== undefined) params.timings.rerankMs = Date.now() - rerankStart;
  };
  const ids = fused.map((h) => h.chunk_id);
  const { data: rows, error: textErr } = await db
    .from('doc_chunks')
    .select('chunk_id, text')
    .eq('org_id', params.orgId) // U11: redundant org scope (defense-in-depth; db.ts convention)
    .in('chunk_id', ids);
  if (textErr !== null || rows === null) {
    params.logger?.warn({ err: textErr }, 'corpus-search.rerank.text-fetch-failed');
    stampRerank();
    return fused.slice(0, params.limit);
  }
  const textById = new Map(
    (rows as { chunk_id: string; text: string }[]).map((r) => [r.chunk_id, r.text]),
  );
  const documents = fused.map((h) => textById.get(h.chunk_id) ?? '');
  try {
    const ranked = await params.reranker(params.rerankQuery ?? params.queryText, documents, {
      topK: params.limit,
    });
    const reordered = ranked
      .map((r) => fused[r.index])
      .filter((h): h is HybridHit => h !== undefined);
    stampRerank();
    return reordered.slice(0, params.limit);
  } catch (err) {
    params.logger?.warn({ err }, 'corpus-search.rerank.failed');
    stampRerank();
    return fused.slice(0, params.limit);
  }
}
