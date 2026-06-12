-- Latency C1-lite: the hybrid-search RPCs return the chunk body + doc metadata
-- INLINE, so the hot retrieval path stops paying three follow-up round-trips:
-- the reranker's chunk-text fetch and the core's doc_chunks + docs enrichment
-- reads (measured ~0.2s + ~0.2s per question). The candidate selection (HNSW /
-- FTS scan + limit) runs first in a CTE; the joins then touch only the top-N
-- rows (nested loop over ≤ p_limit primary keys — negligible).
--
-- Backward/forward compatible: callers reading only chunk_id + distance/rank
-- (the old shape) keep working — the rows just carry extra columns. RLS: both
-- functions stay SECURITY INVOKER; doc_chunks/docs have member-read policies,
-- so authenticated callers see exactly what they could already read.

------------------------------------------------------------
-- 1. search_corpus_vector — enriched returns
------------------------------------------------------------
drop function if exists public.search_corpus_vector(uuid, text, int, uuid[], text, text[]);

create function public.search_corpus_vector(
  p_org_id uuid,
  p_query_vector text,
  p_limit int default 20,
  p_source_ids uuid[] default null,
  p_domain text default null,
  p_team_ids text[] default null
)
  returns table (
    chunk_id text,
    distance double precision,
    doc_id text,
    domain text,
    body text,
    chunk_position int,
    is_summary boolean,
    title text,
    url text,
    doc_source text,
    doc_type text
  )
  language sql
  security invoker
  stable
  -- `extensions` is required: pgvector (the `vector` type + `<=>` operator)
  -- lives there (relocated by 20260612060000).
  set search_path = pg_catalog, public, extensions
as $$
  with cand as (
    select c.chunk_id, (c.embedding <=> p_query_vector::vector)::double precision as distance
    from public.corpus_chunk_embeddings c
    where c.org_id = p_org_id
      and (p_source_ids is null or c.source_id = any(p_source_ids))
      and (p_domain is null or c.domain = p_domain)
      and (p_team_ids is null or c.visible_team_ids && p_team_ids)
    order by c.embedding <=> p_query_vector::vector
    limit p_limit
  )
  select cand.chunk_id, cand.distance,
         dc.doc_id, dc.domain, dc.text as body, dc.position as chunk_position, dc.is_summary,
         d.title, d.url, d.source as doc_source, d.type as doc_type
  from cand
  join public.doc_chunks dc on dc.chunk_id = cand.chunk_id
  join public.docs d on d.id = dc.doc_id
  order by cand.distance;
$$;

revoke execute on function public.search_corpus_vector(uuid, text, int, uuid[], text, text[]) from public, anon;
grant execute on function public.search_corpus_vector(uuid, text, int, uuid[], text, text[]) to authenticated, service_role;

------------------------------------------------------------
-- 2. search_corpus_fts — enriched returns
------------------------------------------------------------
drop function if exists public.search_corpus_fts(uuid, text, int, uuid[], text[]);

create function public.search_corpus_fts(
  p_org_id uuid,
  p_query text,
  p_limit int default 20,
  p_source_ids uuid[] default null,
  p_team_ids text[] default null
)
  returns table (
    chunk_id text,
    rank double precision,
    doc_id text,
    domain text,
    body text,
    chunk_position int,
    is_summary boolean,
    title text,
    url text,
    doc_source text,
    doc_type text
  )
  language sql
  security invoker
  stable
  set search_path = pg_catalog, public
as $$
  with cand as (
    select dc.chunk_id, ts_rank(dc.text_fts, q)::double precision as rank
    from public.doc_chunks dc, websearch_to_tsquery('english', p_query) q
    where dc.org_id = p_org_id
      and dc.text_fts @@ q
      and (p_source_ids is null or dc.source_id = any(p_source_ids))
      and (p_team_ids is null or dc.visible_team_ids && p_team_ids)
    order by ts_rank(dc.text_fts, q) desc
    limit p_limit
  )
  select cand.chunk_id, cand.rank,
         dc.doc_id, dc.domain, dc.text as body, dc.position as chunk_position, dc.is_summary,
         d.title, d.url, d.source as doc_source, d.type as doc_type
  from cand
  join public.doc_chunks dc on dc.chunk_id = cand.chunk_id
  join public.docs d on d.id = dc.doc_id
  order by cand.rank desc;
$$;

revoke execute on function public.search_corpus_fts(uuid, text, int, uuid[], text[]) from public, anon;
grant execute on function public.search_corpus_fts(uuid, text, int, uuid[], text[]) to authenticated, service_role;
