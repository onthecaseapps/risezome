import type { ReactElement } from 'react';
import { VoyageEmbedder } from '@risezome/engine/embed';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';

/**
 * Retrieval debug page. Type a query → embed → hybrid (vector + FTS)
 * search against the indexed corpus → top chunks with snippets.
 *
 * This is intentionally a developer-facing surface, not the eventual
 * end-user search UI:
 *   - GET form so the URL captures the query (reloadable, shareable).
 *   - All scores exposed so we can eyeball whether vector + FTS agree.
 *   - No synthesis layer; we show raw chunks to validate the corpus.
 *
 * Search shape:
 *   - vector: top 20 by cosine distance (HNSW)
 *   - FTS:    top 20 by ts_rank against `text_fts` (GIN)
 *   - combine via reciprocal rank fusion (k = 60), keep top 10
 *
 * RLS via `createServerClient` scopes results to the current org; the
 * RPCs are SECURITY INVOKER with a redundant `p_org_id` filter as
 * defense-in-depth.
 */

const RRF_K = 60;
const VECTOR_K = 20;
const FTS_K = 20;
const FINAL_K = 10;

interface ChunkHit {
  chunk_id: string;
  vectorRank: number | null;
  vectorDistance: number | null;
  ftsRank: number | null;
  ftsScore: number | null;
  rrfScore: number;
}

interface EnrichedHit extends ChunkHit {
  doc_id: string;
  doc_title: string;
  doc_url: string | null;
  domain: string;
  position: number;
  text: string;
}

export default async function AskPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const { orgId, orgName } = await requireAuthedUserWithOrg();
  const params = await props.searchParams;
  const queryRaw = firstParam(params['q']);
  const query = queryRaw?.trim() ?? '';

  let hits: EnrichedHit[] = [];
  let error: string | null = null;
  let elapsedMs = 0;
  let stats = { vectorCount: 0, ftsCount: 0 };

  if (query.length > 0) {
    const t0 = Date.now();
    try {
      const result = await runHybridSearch(orgId, query);
      hits = result.hits;
      stats = { vectorCount: result.vectorCount, ftsCount: result.ftsCount };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    elapsedMs = Date.now() - t0;
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Debug · Ask</h1>
        <p className="mt-1.5 text-sm text-muted">
          Hybrid search against <span className="text-fg">{orgName}</span>&apos;s indexed corpus.
          Vector + FTS, combined via RRF.
        </p>
      </header>

      <form method="get" action="/debug/ask" className="mb-6 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="What does the install-callback handler do?"
          className="flex-1 rounded-lg border border-border bg-card px-3.5 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
          autoFocus
        />
        <button
          type="submit"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-press"
        >
          Search
        </button>
      </form>

      {error !== null ? (
        <div className="mb-6 rounded-lg border border-rose-400/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          Search failed: {error}
        </div>
      ) : null}

      {query.length > 0 && error === null ? (
        <>
          <div className="mb-3 text-xs text-muted">
            {hits.length} result{hits.length === 1 ? '' : 's'} · {stats.vectorCount} vector · {stats.ftsCount} FTS · {elapsedMs} ms
          </div>
          {hits.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted">
              No matches. The corpus has chunks but neither vector similarity nor FTS surfaced anything for this query.
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {hits.map((h) => (
                <HitCard key={h.chunk_id} hit={h} />
              ))}
            </ul>
          )}
        </>
      ) : null}

      {query.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted">
          Type a query above. This page is for sanity-checking the indexer&apos;s output —
          it shows raw chunks with no synthesis layer.
        </div>
      ) : null}
    </div>
  );
}

function HitCard({ hit }: { hit: EnrichedHit }): ReactElement {
  return (
    <li className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {hit.doc_url !== null ? (
            <a
              href={hit.doc_url}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-sm font-medium text-fg hover:underline"
            >
              {hit.doc_title}
            </a>
          ) : (
            <span className="truncate font-mono text-sm font-medium text-fg">{hit.doc_title}</span>
          )}
          <div className="mt-0.5 text-[11px] text-muted">
            chunk #{hit.position} · {hit.domain}
          </div>
        </div>
        <ScoreBadges hit={hit} />
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-bg/60 p-3 text-xs leading-snug text-fg">
        {truncate(hit.text, 800)}
      </pre>
    </li>
  );
}

function ScoreBadges({ hit }: { hit: ChunkHit }): ReactElement {
  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-0.5 text-[11px] text-muted">
      <span className="font-medium text-accent">RRF {hit.rrfScore.toFixed(3)}</span>
      {hit.vectorRank !== null ? (
        <span>
          vec #{hit.vectorRank + 1} · {hit.vectorDistance!.toFixed(3)}
        </span>
      ) : null}
      {hit.ftsRank !== null ? (
        <span>
          fts #{hit.ftsRank + 1} · {hit.ftsScore!.toFixed(3)}
        </span>
      ) : null}
    </div>
  );
}

/* ---------- search core ---------- */

async function runHybridSearch(
  orgId: string,
  query: string,
): Promise<{ hits: EnrichedHit[]; vectorCount: number; ftsCount: number }> {
  // Embed the query as a `text` domain. The indexer routes file content
  // to voyage-3-large (text) or voyage-code-3 (code); for queries we
  // always use the text model because we don't know in advance whether
  // the user is looking for prose or code chunks.
  const embedder = new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') });
  const embedResult = await embedder.embed({
    items: [{ text: query, domain: 'text' }],
  });
  const queryVector = embedResult.vectors[0]?.vector;
  if (queryVector === undefined) {
    throw new Error('embed returned no vectors');
  }
  const queryVectorLiteral = `[${Array.from(queryVector).join(',')}]`;

  const supabase = await createServerClient();

  const [vectorResp, ftsResp] = await Promise.all([
    supabase.rpc('search_corpus_vector', {
      p_org_id: orgId,
      p_query_vector: queryVectorLiteral,
      p_limit: VECTOR_K,
    }),
    supabase.rpc('search_corpus_fts', {
      p_org_id: orgId,
      p_query: query,
      p_limit: FTS_K,
    }),
  ]);

  if (vectorResp.error !== null) throw new Error(`vector: ${vectorResp.error.message}`);
  if (ftsResp.error !== null) throw new Error(`fts: ${ftsResp.error.message}`);

  const vectorRows = (vectorResp.data ?? []) as Array<{ chunk_id: string; distance: number }>;
  const ftsRows = (ftsResp.data ?? []) as Array<{ chunk_id: string; rank: number }>;

  // Reciprocal rank fusion. Score = sum over sides of 1 / (k + rank_i).
  const merged = new Map<string, ChunkHit>();
  vectorRows.forEach((row, i) => {
    merged.set(row.chunk_id, {
      chunk_id: row.chunk_id,
      vectorRank: i,
      vectorDistance: row.distance,
      ftsRank: null,
      ftsScore: null,
      rrfScore: 1 / (RRF_K + i + 1),
    });
  });
  ftsRows.forEach((row, i) => {
    const existing = merged.get(row.chunk_id);
    const contribution = 1 / (RRF_K + i + 1);
    if (existing === undefined) {
      merged.set(row.chunk_id, {
        chunk_id: row.chunk_id,
        vectorRank: null,
        vectorDistance: null,
        ftsRank: i,
        ftsScore: row.rank,
        rrfScore: contribution,
      });
    } else {
      existing.ftsRank = i;
      existing.ftsScore = row.rank;
      existing.rrfScore += contribution;
    }
  });

  const ranked = Array.from(merged.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, FINAL_K);

  if (ranked.length === 0) {
    return { hits: [], vectorCount: vectorRows.length, ftsCount: ftsRows.length };
  }

  // Fetch chunk + doc metadata for the surviving chunks in one round-trip
  // each. supabase-js's `.in()` with the join shape keeps this two queries.
  const chunkIds = ranked.map((r) => r.chunk_id);
  const { data: chunkRows, error: chunkErr } = await supabase
    .from('doc_chunks')
    .select('chunk_id, doc_id, domain, text, position')
    .in('chunk_id', chunkIds);
  if (chunkErr !== null) throw new Error(`chunk fetch: ${chunkErr.message}`);

  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      {
        doc_id: c.doc_id as string,
        domain: c.domain as string,
        text: c.text as string,
        position: c.position as number,
      },
    ]),
  );

  const docIds = Array.from(new Set(Array.from(chunkById.values()).map((c) => c.doc_id)));
  const { data: docRows, error: docErr } = await supabase
    .from('docs')
    .select('id, title, url')
    .in('id', docIds);
  if (docErr !== null) throw new Error(`doc fetch: ${docErr.message}`);

  const docById = new Map(
    (docRows ?? []).map((d) => [
      d.id as string,
      { title: d.title as string, url: (d.url as string | null) ?? null },
    ]),
  );

  const enriched: EnrichedHit[] = [];
  for (const hit of ranked) {
    const c = chunkById.get(hit.chunk_id);
    if (c === undefined) continue; // chunk vanished mid-flight; skip
    const d = docById.get(c.doc_id);
    enriched.push({
      ...hit,
      doc_id: c.doc_id,
      doc_title: d?.title ?? c.doc_id,
      doc_url: d?.url ?? null,
      domain: c.domain,
      position: c.position,
      text: c.text,
    });
  }
  return { hits: enriched, vectorCount: vectorRows.length, ftsCount: ftsRows.length };
}

function firstParam(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
