import type { Database as DatabaseType } from 'better-sqlite3';
import { CorpusError, DEFAULT_EMBEDDING_DIM } from './db.js';
import { buildFtsQuery, hasEntityLikeToken } from '@risezome/engine/chunker';
import type { CanonicalChunk, CanonicalDoc, RetrievalResult } from './types.js';

export const RRF_K = 60;

export interface HybridSearchOptions {
  readonly limit?: number;
  readonly minScore?: number;
  readonly embeddingDim?: number;
}

interface DocRow {
  id: string;
  source: string;
  type: string;
  title: string;
  body_summary: string;
  entities: string;
  authors: string;
  updated_at: number;
  url: string | null;
  acl: string;
  provenance: string;
}

interface ChunkSearchHit {
  chunk_id: string;
  doc_id: string;
  text: string;
  rank: number;
  raw_score: number;
}

export function insertDoc(db: DatabaseType, doc: CanonicalDoc): void {
  // ON CONFLICT DO UPDATE (UPSERT), not INSERT OR REPLACE. REPLACE is a
  // DELETE+INSERT under the hood, which triggers the ON DELETE CASCADE on
  // doc_chunks and silently wipes every chunk for the doc — orphaning the
  // corresponding vec_doc_chunks rows (vec is a virtual table without FK).
  // UPSERT updates the doc in place; chunks survive.
  db.prepare(
    `INSERT INTO docs
       (id, source, type, title, body_summary, entities, authors, updated_at, url, acl, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source,
       type = excluded.type,
       title = excluded.title,
       body_summary = excluded.body_summary,
       entities = excluded.entities,
       authors = excluded.authors,
       updated_at = excluded.updated_at,
       url = excluded.url,
       acl = excluded.acl,
       provenance = excluded.provenance`,
  ).run(
    doc.id,
    doc.source,
    doc.type,
    doc.title,
    doc.bodySummary,
    JSON.stringify(doc.entities),
    JSON.stringify(doc.authors),
    doc.updatedAt,
    doc.url ?? null,
    JSON.stringify(doc.acl ?? {}),
    doc.provenance ?? 'untrusted',
  );
}

export function hasChunkEmbedding(db: DatabaseType, chunkId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM vec_doc_chunks WHERE chunk_id = ? LIMIT 1')
    .get(chunkId) as { present?: number } | undefined;
  return row?.present === 1;
}

export function insertChunk(
  db: DatabaseType,
  chunk: CanonicalChunk,
  options: { embeddingDim?: number } = {},
): void {
  const dim = options.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  if (chunk.embedding !== undefined && chunk.embedding.length !== dim) {
    throw new CorpusError(
      'corpus-embedding-dim',
      `Embedding dimension mismatch: expected ${String(dim)}, got ${String(chunk.embedding.length)}`,
    );
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO doc_chunks (chunk_id, doc_id, domain, text, position)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         doc_id = excluded.doc_id,
         domain = excluded.domain,
         text = excluded.text,
         position = excluded.position`,
    ).run(chunk.chunkId, chunk.docId, chunk.domain, chunk.text, chunk.position ?? 0);

    const titleRow = db.prepare('SELECT title FROM docs WHERE id = ?').get(chunk.docId) as
      | { title?: string }
      | undefined;
    const title = titleRow?.title ?? '';

    db.prepare('DELETE FROM fts_doc_chunks WHERE chunk_id = ?').run(chunk.chunkId);
    db.prepare(
      `INSERT INTO fts_doc_chunks (chunk_id, doc_id, title, text) VALUES (?, ?, ?, ?)`,
    ).run(chunk.chunkId, chunk.docId, title, chunk.text);

    if (chunk.embedding !== undefined) {
      db.prepare('DELETE FROM vec_doc_chunks WHERE chunk_id = ?').run(chunk.chunkId);
      db.prepare('INSERT INTO vec_doc_chunks (chunk_id, embedding) VALUES (?, ?)').run(
        chunk.chunkId,
        Buffer.from(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength),
      );
    }
  });
  tx();
}

function loadDoc(db: DatabaseType, docId: string): CanonicalDoc | null {
  const row = db.prepare('SELECT * FROM docs WHERE id = ?').get(docId) as DocRow | undefined;
  if (row === undefined) return null;
  const doc: CanonicalDoc = {
    id: row.id,
    source: row.source,
    type: row.type,
    title: row.title,
    bodySummary: row.body_summary,
    entities: JSON.parse(row.entities) as string[],
    authors: JSON.parse(row.authors) as string[],
    updatedAt: row.updated_at,
    acl: JSON.parse(row.acl) as Record<string, unknown>,
    provenance: row.provenance as 'trusted' | 'untrusted',
    ...(row.url !== null && { url: row.url }),
  };
  return doc;
}

function bm25Hits(db: DatabaseType, query: string, limit: number): ChunkSearchHit[] {
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT chunk_id, doc_id, text, bm25(fts_doc_chunks) AS raw_score
       FROM fts_doc_chunks
       WHERE fts_doc_chunks MATCH ?
       ORDER BY raw_score
       LIMIT ?`,
    )
    .all(ftsQuery, limit) as Omit<ChunkSearchHit, 'rank'>[];
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

function vectorHits(
  db: DatabaseType,
  embedding: Float32Array,
  limit: number,
  embeddingDim: number,
): ChunkSearchHit[] {
  if (embedding.length !== embeddingDim) {
    throw new CorpusError(
      'corpus-embedding-dim',
      `Query embedding dimension ${String(embedding.length)} does not match expected ${String(embeddingDim)}`,
    );
  }
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const rows = db
    .prepare(
      `SELECT v.chunk_id AS chunk_id,
              c.doc_id AS doc_id,
              c.text AS text,
              v.distance AS raw_score
         FROM vec_doc_chunks v
         JOIN doc_chunks c ON c.chunk_id = v.chunk_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance`,
    )
    .all(buf, limit) as Omit<ChunkSearchHit, 'rank'>[];
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

interface FusedRow {
  docId: string;
  bestChunkId: string;
  bestText: string;
  bestRank: number;
  score: number;
  source: 'vector' | 'bm25' | 'hybrid';
}

function rrfFuse(
  perRanker: ChunkSearchHit[][],
  perRankerSource: ('vector' | 'bm25')[],
): FusedRow[] {
  const byDoc = new Map<string, FusedRow>();

  perRanker.forEach((hits, rankerIdx) => {
    const sourceTag = perRankerSource[rankerIdx];
    if (sourceTag === undefined) return;
    for (const hit of hits) {
      const contribution = 1 / (RRF_K + hit.rank);
      const existing = byDoc.get(hit.doc_id);
      if (existing === undefined) {
        byDoc.set(hit.doc_id, {
          docId: hit.doc_id,
          bestChunkId: hit.chunk_id,
          bestText: hit.text,
          bestRank: hit.rank,
          score: contribution,
          source: sourceTag,
        });
        continue;
      }
      existing.score += contribution;
      existing.source = existing.source === sourceTag ? sourceTag : 'hybrid';
      // Prefer the chunk with the lowest rank from any ranker as the snippet.
      // On ties, BM25 wins because exact-string anchors make better snippets than semantic matches.
      const isStrictlyBetter = hit.rank < existing.bestRank;
      const isTiedAndBm25 = hit.rank === existing.bestRank && sourceTag === 'bm25';
      if (isStrictlyBetter || isTiedAndBm25) {
        existing.bestChunkId = hit.chunk_id;
        existing.bestText = hit.text;
        existing.bestRank = hit.rank;
      }
    }
  });

  return [...byDoc.values()].sort((a, b) => b.score - a.score);
}

export function vectorSearch(
  db: DatabaseType,
  embedding: Float32Array,
  options: HybridSearchOptions = {},
): RetrievalResult[] {
  const limit = options.limit ?? 10;
  const embeddingDim = options.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  const hits = vectorHits(db, embedding, limit, embeddingDim);
  return hitsToResults(db, hits, 'vector').slice(0, limit);
}

export function bm25Search(
  db: DatabaseType,
  query: string,
  options: HybridSearchOptions = {},
): RetrievalResult[] {
  const limit = options.limit ?? 10;
  const hits = bm25Hits(db, query, limit);
  return hitsToResults(db, hits, 'bm25').slice(0, limit);
}

function hitsToResults(
  db: DatabaseType,
  hits: ChunkSearchHit[],
  sourceTag: 'vector' | 'bm25',
): RetrievalResult[] {
  const seen = new Set<string>();
  const results: RetrievalResult[] = [];
  for (const hit of hits) {
    if (seen.has(hit.doc_id)) continue;
    seen.add(hit.doc_id);
    const doc = loadDoc(db, hit.doc_id);
    if (doc === null) continue;
    results.push({
      doc,
      bestChunkId: hit.chunk_id,
      snippet: hit.text,
      score: 1 / (RRF_K + hit.rank),
      source: sourceTag,
    });
  }
  return results;
}

export function hybridSearch(
  db: DatabaseType,
  query: string,
  embedding: Float32Array,
  options: HybridSearchOptions = {},
): RetrievalResult[] {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0;
  const embeddingDim = options.embeddingDim ?? DEFAULT_EMBEDDING_DIM;

  const useBm25 = hasEntityLikeToken(query);
  const vec = vectorHits(db, embedding, limit * 2, embeddingDim);
  const bm25 = useBm25 ? bm25Hits(db, query, limit * 2) : [];

  const fused = rrfFuse([vec, bm25], ['vector', 'bm25']);
  const results: RetrievalResult[] = [];
  for (const f of fused) {
    if (f.score < minScore) continue;
    const doc = loadDoc(db, f.docId);
    if (doc === null) continue;
    results.push({
      doc,
      bestChunkId: f.bestChunkId,
      snippet: f.bestText,
      score: f.score,
      source: f.source,
    });
    if (results.length >= limit) break;
  }
  return results;
}
