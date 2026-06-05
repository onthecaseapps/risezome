-- Denormalize source_id onto the chunk + embedding tables (teams restructure U4).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U4; KTD5.
--
-- Meeting-time retrieval is now filtered to the meeting's effective source set
-- (the union of its attendees' teams' sources). The HNSW vector search runs over
-- corpus_chunk_embeddings and the FTS over doc_chunks; filtering those by source
-- without a join to docs in the hot path requires source_id ON those tables. The
-- corpus stays org-level and deduplicated — this is a denormalized filter column,
-- NOT team scoping (KTD3): no team_id touches the corpus.
--
-- Backfill source_id from docs (docs.source_id is NOT NULL; doc_chunks.doc_id FKs
-- to docs, so every chunk maps to exactly one source). New writes stamp it in the
-- indexer (connector-index.ts).

------------------------------------------------------------
-- 1. doc_chunks.source_id
------------------------------------------------------------
alter table public.doc_chunks
  add column if not exists source_id uuid references public.sources(id) on delete cascade;

update public.doc_chunks dc
set source_id = d.source_id
from public.docs d
where d.id = dc.doc_id and dc.source_id is null;

alter table public.doc_chunks alter column source_id set not null;
create index if not exists doc_chunks_source_id_idx on public.doc_chunks (source_id);

------------------------------------------------------------
-- 2. corpus_chunk_embeddings.source_id
------------------------------------------------------------
alter table public.corpus_chunk_embeddings
  add column if not exists source_id uuid references public.sources(id) on delete cascade;

update public.corpus_chunk_embeddings e
set source_id = dc.source_id
from public.doc_chunks dc
where dc.chunk_id = e.chunk_id and e.source_id is null;

alter table public.corpus_chunk_embeddings alter column source_id set not null;
create index if not exists corpus_chunk_embeddings_source_id_idx
  on public.corpus_chunk_embeddings (source_id);
