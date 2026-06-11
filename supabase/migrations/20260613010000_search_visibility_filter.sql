-- Query-time corpus filtering (U4): add the per-team visibility predicate to the
-- hybrid-search RPCs. A new `p_team_ids text[]` param filters chunks to those
-- whose `visible_team_ids` overlaps the caller's attending teams. NULL (the
-- default) means NO filtering — byte-identical to today — so the bot-worker can
-- gate enforcement behind a flag and only pass team ids once the corpus is
-- stamped/backfilled (the migration ordering guard from the plan).
--
-- Drop the prior arities and recreate with the extra trailing param + predicate.
-- Re-assert the hardened grants (service-role + authenticated; not public/anon).
-- search_path is pinned on both (fts previously lacked it — a lint gap).

------------------------------------------------------------
-- 1. search_corpus_vector — add p_team_ids + visibility predicate
------------------------------------------------------------
drop function if exists public.search_corpus_vector(uuid, text, int, uuid[], text);

create function public.search_corpus_vector(
  p_org_id uuid,
  p_query_vector text,
  p_limit int default 20,
  p_source_ids uuid[] default null,
  p_domain text default null,
  p_team_ids text[] default null
)
  returns table (chunk_id text, distance double precision)
  language sql
  security invoker
  stable
  set search_path = pg_catalog, public
as $$
  select c.chunk_id, (c.embedding <=> p_query_vector::vector)::double precision as distance
  from public.corpus_chunk_embeddings c
  where c.org_id = p_org_id
    and (p_source_ids is null or c.source_id = any(p_source_ids))
    and (p_domain is null or c.domain = p_domain)
    and (p_team_ids is null or c.visible_team_ids && p_team_ids)
  order by c.embedding <=> p_query_vector::vector
  limit p_limit;
$$;

revoke execute on function public.search_corpus_vector(uuid, text, int, uuid[], text, text[]) from public, anon;
grant execute on function public.search_corpus_vector(uuid, text, int, uuid[], text, text[]) to authenticated, service_role;

------------------------------------------------------------
-- 2. search_corpus_fts — add p_team_ids + visibility predicate
------------------------------------------------------------
drop function if exists public.search_corpus_fts(uuid, text, int, uuid[]);

create function public.search_corpus_fts(
  p_org_id uuid,
  p_query text,
  p_limit int default 20,
  p_source_ids uuid[] default null,
  p_team_ids text[] default null
)
  returns table (chunk_id text, rank double precision)
  language sql
  security invoker
  stable
  set search_path = pg_catalog, public
as $$
  select dc.chunk_id, ts_rank(dc.text_fts, q)::double precision as rank
  from public.doc_chunks dc, websearch_to_tsquery('english', p_query) q
  where dc.org_id = p_org_id
    and dc.text_fts @@ q
    and (p_source_ids is null or dc.source_id = any(p_source_ids))
    and (p_team_ids is null or dc.visible_team_ids && p_team_ids)
  order by ts_rank(dc.text_fts, q) desc
  limit p_limit;
$$;

revoke execute on function public.search_corpus_fts(uuid, text, int, uuid[], text[]) from public, anon;
grant execute on function public.search_corpus_fts(uuid, text, int, uuid[], text[]) to authenticated, service_role;
