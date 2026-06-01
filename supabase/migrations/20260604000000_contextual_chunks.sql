-- Contextual Retrieval (U3 of the Claude-augmented RAG plan).
--
-- At index time each chunk gets a short LLM-generated context situating it
-- within its source document. That context is prepended to the text fed to
-- the embedder AND folded into the FTS vector (contextual embeddings +
-- contextual BM25), while `text` stays the verbatim chunk body so card
-- display and citation-quote matching are unchanged.
--
-- The embedded vector is computed at index time from (context + body) by the
-- indexer; here we (1) add the `context` column and (2) recompute the
-- generated `text_fts` vector from context + body.

alter table public.doc_chunks add column if not exists context text;

-- Rebuild the generated FTS column to include context. A generated column's
-- expression can't be altered in place, so drop its index + the column and
-- recreate both.
drop index if exists public.doc_chunks_text_fts_idx;
alter table public.doc_chunks drop column if exists text_fts;
alter table public.doc_chunks
  add column text_fts tsvector
  generated always as (to_tsvector('english', coalesce(context, '') || ' ' || text)) stored;
create index doc_chunks_text_fts_idx on public.doc_chunks using gin (text_fts);
