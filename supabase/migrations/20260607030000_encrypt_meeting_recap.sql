-- Encrypt the whole-meeting recap at rest (security U9 / S9).
--
-- meetings.recap_text is a single-write / single-read, NON-searched summary of
-- an entire meeting — high-sensitivity PII (it condenses everything said).
-- Encrypt it via the pgcrypto AES-256 helpers (KTD1), keyed by
-- USER_TOKEN_ENCRYPTION_KEY which the DB never stores. recap_key_version exists
-- for the re-wrap rotation (U10).
--
-- The OTHER customer-content columns rely on disk-level (Supabase volume)
-- encryption only, by deliberate decision recorded in
-- docs/solutions/2026-06-03-content-encryption-at-rest.md, because column
-- encryption would break how they are used:
--   - meeting_events.payload      — queried via payload->>'speaker' (capture_card_stats)
--   - syntheses.accumulated_text  — written incrementally in the live synthesis
--                                   pipeline (bot-worker); encrypting the hot path is deferred
--   - doc_chunks.text + corpus_chunk_embeddings — FTS generated tsvector + HNSW
--                                                  vector search

alter table public.meetings
  add column recap_text_enc bytea,
  add column recap_key_version integer not null default 0;

alter table public.meetings drop column recap_text;
