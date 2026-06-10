-- Domain-partitioned dense retrieval.
--
-- Code chunks are embedded with voyage-code-3 and text chunks with
-- voyage-3-large — DIFFERENT embedding spaces — but both vectors live in one
-- corpus_chunk_embeddings.embedding column, and queries were embedded only as
-- text. So a text-model query vector was being cosine-compared against
-- code-model document vectors: meaningless distances, broken dense retrieval for
-- code. The fix searches each space with the matching query vector, which needs
-- a domain to filter on at the embedding row.
--
-- This is a backfill of an existing column (denormalized from doc_chunks, like
-- source_id was) — NOT a re-embedding. The vectors are already correct per
-- domain; we just label them so the query side can partition.

-- 1. domain column on the embeddings table.
alter table public.corpus_chunk_embeddings
  add column if not exists domain text;

-- 2. Backfill from doc_chunks (the authoritative per-chunk domain).
update public.corpus_chunk_embeddings e
set domain = dc.domain
from public.doc_chunks dc
where dc.chunk_id = e.chunk_id and e.domain is null;

-- 3. Anything still null (an embedding whose chunk was deleted mid-flight, or a
--    legacy row) defaults to 'text' — the conservative space (voyage-3-large is
--    a general model). NOT NULL so future writes must label.
update public.corpus_chunk_embeddings set domain = 'text' where domain is null;
alter table public.corpus_chunk_embeddings alter column domain set not null;
alter table public.corpus_chunk_embeddings
  add constraint corpus_chunk_embeddings_domain_check check (domain in ('text', 'code'));

-- 4. Help the domain pre-filter on the vector search.
create index if not exists corpus_chunk_embeddings_org_domain_idx
  on public.corpus_chunk_embeddings (org_id, domain);

-- 5. search_corpus_vector gains an optional p_domain filter (null = no filter,
--    preserving the old whole-corpus behavior for any caller that omits it).
create or replace function public.search_corpus_vector(
  p_org_id uuid,
  p_query_vector text,
  p_limit int default 20,
  p_source_ids uuid[] default null,
  p_domain text default null
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
  order by c.embedding <=> p_query_vector::vector
  limit p_limit;
$$;

-- The old 4-arg signature is now shadowed by the 5-arg default; drop it so
-- PostgREST resolves the call unambiguously and the grant carries over.
drop function if exists public.search_corpus_vector(uuid, text, int, uuid[]);
revoke execute on function public.search_corpus_vector(uuid, text, int, uuid[], text) from public, anon;
grant execute on function public.search_corpus_vector(uuid, text, int, uuid[], text) to authenticated, service_role;
