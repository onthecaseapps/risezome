-- Helper RPCs for the retrieval debug page (and, later, U7 retrieval).
--
-- Both functions are SECURITY INVOKER — they run as the calling user, so
-- RLS still applies and limits results to chunks the user can already
-- read. The `org_id` argument is defense-in-depth: a redundant filter at
-- the SQL level so a bug in the caller can't accidentally widen the scope.
--
-- Vector search uses pgvector's cosine distance operator `<=>`, matched
-- to the HNSW index in 20260601000000_corpus_pgvector.sql
-- (`vector_cosine_ops`). FTS uses the generated `text_fts` column +
-- GIN index from the same migration, queried with `websearch_to_tsquery`
-- so users can type natural-ish queries (`"foo bar" -baz` works).

create or replace function public.search_corpus_vector(
  p_org_id uuid,
  p_query_vector text,
  p_limit int default 20
)
returns table (chunk_id text, distance double precision)
language sql
security invoker
stable
as $$
  select c.chunk_id, (c.embedding <=> p_query_vector::vector)::double precision as distance
  from public.corpus_chunk_embeddings c
  where c.org_id = p_org_id
  order by c.embedding <=> p_query_vector::vector
  limit p_limit;
$$;

create or replace function public.search_corpus_fts(
  p_org_id uuid,
  p_query text,
  p_limit int default 20
)
returns table (chunk_id text, rank double precision)
language sql
security invoker
stable
as $$
  select dc.chunk_id, ts_rank(dc.text_fts, q)::double precision as rank
  from public.doc_chunks dc, websearch_to_tsquery('english', p_query) q
  where dc.org_id = p_org_id and dc.text_fts @@ q
  order by ts_rank(dc.text_fts, q) desc
  limit p_limit;
$$;

-- Grant execute to the `authenticated` role so user-scoped clients
-- (createServerClient) can call these via .rpc(). Anon role is excluded.
grant execute on function public.search_corpus_vector(uuid, text, int) to authenticated;
grant execute on function public.search_corpus_fts(uuid, text, int) to authenticated;
