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

function envFloor(): number {
  const raw = process.env.RISEZOME_VECTOR_DISTANCE_FLOOR;
  if (raw === undefined) return DEFAULT_VECTOR_DISTANCE_FLOOR;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VECTOR_DISTANCE_FLOOR;
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
 * True when there are no hits, or when no hit is "strong" — i.e. every hit is
 * a vector-only near-miss (no lexical anchor) beyond `strongDistance()`. A
 * single FTS-matched or close-vector hit makes the set confident.
 */
export function isLowConfidenceHits(hits: readonly HybridHit[]): boolean {
  if (hits.length === 0) return true;
  const strong = strongDistance();
  return !hits.some((h) => h.ftsMatched || (h.distance !== null && h.distance <= strong));
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
  const k = opts.rrfK ?? DEFAULT_RRF_K;
  const floor = opts.vectorDistanceFloor ?? envFloor();

  const byId = new Map<string, { distance: number | null; ftsMatched: boolean; score: number }>();
  const get = (id: string) => {
    let e = byId.get(id);
    if (e === undefined) {
      e = { distance: null, ftsMatched: false, score: 0 };
      byId.set(id, e);
    }
    return e;
  };

  vector.forEach((row, i) => {
    const e = get(row.chunk_id);
    e.distance = row.distance;
    e.score += 1 / (k + i + 1);
  });
  fts.forEach((row, i) => {
    const e = get(row.chunk_id);
    e.ftsMatched = true;
    e.score += 1 / (k + i + 1);
  });

  return (
    [...byId.entries()]
      // Floor: lexical matches always pass; vector-only must be close enough.
      .filter(([, e]) => e.ftsMatched || (e.distance !== null && e.distance <= floor))
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
  /** pgvector literal: `[0.1,0.2,...]`. */
  readonly queryVectorLiteral: string;
  /** Natural-ish text for websearch_to_tsquery (the rolling window). */
  readonly queryText: string;
  readonly limit: number;
  readonly candidateLimit?: number;
  /** The meeting's effective source set (teams restructure U4): the union of its
   *  attendees' teams' sources. Restricts both the vector and FTS legs to these
   *  sources. `undefined` ⇒ no source filter (whole-org corpus, e.g. the debug
   *  page). An EMPTY array ⇒ no in-scope sources ⇒ no corpus hits. */
  readonly sourceIds?: readonly string[];
  /** Optional cross-encoder reranker (U4). When set, the fused candidate
   *  pool is reranked by query-document relevance and truncated to `limit`;
   *  on any rerank error the RRF order is kept (graceful degrade). */
  readonly reranker?: Reranker | undefined;
  readonly logger?: { warn: (obj: object, msg?: string) => void };
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
  if (params.sourceIds !== undefined && params.sourceIds.length === 0) {
    return [];
  }
  // `null` p_source_ids ⇒ the RPC skips the source filter (whole-org corpus).
  const pSourceIds = params.sourceIds === undefined ? null : [...params.sourceIds];

  const [vecRaw, ftsRaw] = await Promise.all([
    db.rpc('search_corpus_vector', {
      p_org_id: params.orgId,
      p_query_vector: params.queryVectorLiteral,
      p_limit: candidateLimit,
      p_source_ids: pSourceIds,
    }),
    db.rpc('search_corpus_fts', {
      p_org_id: params.orgId,
      p_query: params.queryText,
      p_limit: candidateLimit,
      p_source_ids: pSourceIds,
    }),
  ]);
  const vecRes = vecRaw as unknown as {
    data: VectorCandidate[] | null;
    error: { message: string } | null;
  };
  const ftsRes = ftsRaw as unknown as {
    data: FtsCandidate[] | null;
    error: { message: string } | null;
  };

  if (vecRes.error !== null) {
    params.logger?.warn({ err: vecRes.error }, 'corpus-search.vector.failed');
    return [];
  }
  if (ftsRes.error !== null) {
    // Lexical leg is best-effort; fall back to vector-only.
    params.logger?.warn({ err: ftsRes.error }, 'corpus-search.fts.failed');
  }

  const fused = fuseRrf(vecRes.data ?? [], ftsRes.error === null ? (ftsRes.data ?? []) : [], {
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
  const ids = fused.map((h) => h.chunk_id);
  const { data: rows, error: textErr } = await db
    .from('doc_chunks')
    .select('chunk_id, text')
    .eq('org_id', params.orgId) // U11: redundant org scope (defense-in-depth; db.ts convention)
    .in('chunk_id', ids);
  if (textErr !== null || rows === null) {
    params.logger?.warn({ err: textErr }, 'corpus-search.rerank.text-fetch-failed');
    return fused.slice(0, params.limit);
  }
  const textById = new Map(
    (rows as { chunk_id: string; text: string }[]).map((r) => [r.chunk_id, r.text]),
  );
  const documents = fused.map((h) => textById.get(h.chunk_id) ?? '');
  try {
    const ranked = await params.reranker(params.queryText, documents, { topK: params.limit });
    const reordered = ranked
      .map((r) => fused[r.index])
      .filter((h): h is HybridHit => h !== undefined);
    return reordered.slice(0, params.limit);
  } catch (err) {
    params.logger?.warn({ err }, 'corpus-search.rerank.failed');
    return fused.slice(0, params.limit);
  }
}
