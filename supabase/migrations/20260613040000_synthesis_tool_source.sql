-- Tool source on synthesis rows (skill-result-as-cited-source).
--
-- When the router executes a skill (e.g. github_count), its result rides
-- into synthesis as source[0] with the synthetic card id `tool_<traceId>` —
-- no cards row backs it, so a rank-1 citation could never resolve to a
-- visible source row. Persist the formatted tool source on the synthesis
-- itself ({ "cardId", "title", "body" }) so the review page (and the live
-- page via the synthesisStart broadcast) can render it as a CITED row.
-- Null for syntheses without an executed skill.
alter table public.syntheses
  add column tool_source jsonb;
