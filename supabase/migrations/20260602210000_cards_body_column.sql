-- cards.body — full chunk text (substrate for highlight substring search)
--
-- snippet stays at 400-char truncated form (used by captures listing,
-- card-collapsed views, the synthesis-first placeholder source-title
-- line). body carries the full chunk.text the LLM saw at synthesis
-- time, so the click-citation → expand-source → highlight-quote UX
-- (plan U3) has the same substrate the LLM was reasoning over.
--
-- Backfill is best-effort: old rows get body = snippet (lossy for the
-- past-400-char text the LLM may have quoted from, but old cards
-- aren't being re-cited; this is graceful degradation, not silent
-- corruption). Idempotent: re-running the UPDATE is a no-op because
-- the WHERE clause requires body = ''.

alter table public.cards
  add column if not exists body text not null default '';

update public.cards
   set body = snippet
 where body = '';
