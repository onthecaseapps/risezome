-- U6: anchor each synthesis to the transcript utterance that triggered it, so
-- the review page can place an inline, clickable marker at the spot in the
-- transcript where the AI summary was generated.
--
-- Nullable + additive: existing rows stay null (the review page derives a
-- fallback anchor via source_card_ids -> cards.utterance_id), and existing
-- readers ignore the column. No backfill required.

alter table public.syntheses
  add column trigger_utterance_id text;
