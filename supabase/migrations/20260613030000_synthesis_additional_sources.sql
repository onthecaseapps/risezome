-- Additional supporting sources on synthesis answers (plan U3).
--
-- The synthesizer can mark retrieved-but-uncited sources that also support
-- its answer (the optional `ALSO:` protocol line). The validated marks are
-- persisted as resolved references into the synthesis's own source set:
-- [{ "cardId": "...", "rank": N }], mirroring how citations persist resolved
-- cardIds. Default [] keeps previously-serialized rows shape-compatible.
alter table public.syntheses
  add column additional_sources jsonb not null default '[]'::jsonb;
