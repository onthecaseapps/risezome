------------------------------------------------------------
-- Knowledge Gaps — per-gap occurrence aggregates (plan U8)
--   docs/plans/2026-06-02-002-feat-knowledge-gaps-plan.md
--
-- One set-returning function so the library page computes the row meta
-- (people / meetings / moments / phrasings) for every visible gap in ONE
-- round trip, mirroring capture_card_stats. Each gap row in the list shows:
--   people    = distinct asker_name across the gap's occurrences
--   meetings  = distinct meeting_id
--   moments   = total occurrence count
--   phrasings = distinct verbatim_question (the "+N phrasings" pill is this
--               minus 1 for the canonical title, computed in the UI)
--
-- security invoker so gap_occurrences RLS (can_view_gap) still scopes the
-- aggregate to gaps the caller may see; gap_id is the leading index column
-- on gap_occurrences, so each subquery is an index scan.
------------------------------------------------------------

create or replace function public.knowledge_gaps_stats(p_gap_ids text[])
returns table (
  gap_id    text,
  people    integer,
  meetings  integer,
  moments   integer,
  phrasings integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    g.gap_id,
    coalesce((
      select count(distinct o.asker_name)
      from public.gap_occurrences o
      where o.gap_id = g.gap_id
    ), 0)::integer as people,
    coalesce((
      select count(distinct o.meeting_id)
      from public.gap_occurrences o
      where o.gap_id = g.gap_id
    ), 0)::integer as meetings,
    coalesce((
      select count(*)
      from public.gap_occurrences o
      where o.gap_id = g.gap_id
    ), 0)::integer as moments,
    coalesce((
      select count(distinct o.verbatim_question)
      from public.gap_occurrences o
      where o.gap_id = g.gap_id
    ), 0)::integer as phrasings
  from unnest(p_gap_ids) as g(gap_id);
$$;

grant execute on function public.knowledge_gaps_stats(text[]) to authenticated, service_role;
