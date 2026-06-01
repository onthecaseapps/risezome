-- Per-document summaries (U6 of the Claude-augmented RAG plan).
--
-- A doc's Claude-generated summary is stored as a distinguished chunk on the
-- same doc (is_summary = true) rather than a separate doc. This rides the
-- existing doc/chunk reconcile lifecycle (deleted with the doc, replaced with
-- it) with no orphan risk and no new doc type, and the summary chunk is
-- excluded from the content_hash so its LLM-generated text never destabilizes
-- change detection. The routing manifest (U7) selects is_summary chunks.

alter table public.doc_chunks add column if not exists is_summary boolean not null default false;

create index if not exists doc_chunks_is_summary_idx
  on public.doc_chunks (org_id, is_summary)
  where is_summary;
