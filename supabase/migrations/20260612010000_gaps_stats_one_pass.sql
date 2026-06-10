-- Perf: knowledge_gaps_stats ran FOUR correlated subqueries per gap, each one a
-- separate gap_occurrences scan whose RLS predicate (can_view_gap_content — a
-- SECURITY DEFINER exists over gap_viewers) re-evaluates per candidate row.
-- Cost was roughly O(gaps × occurrences × viewer-lookup × 4) and the RPC was the
-- dominant query on the gaps page for busy orgs.
--
-- Rewrite as ONE grouped aggregate pass over gap_occurrences (RLS still applies
-- once per row instead of four times), left-joined back to the requested ids so
-- gaps whose content the caller can't read still return a zeroed row with
-- can_view_content=false — same shape and semantics as before.
--
-- Also add a covering index so the distinct-count aggregate can run index-only
-- instead of heap-fetching every occurrence row.

drop function if exists public.knowledge_gaps_stats(text[]);
create function public.knowledge_gaps_stats(p_gap_ids text[])
returns table (
  gap_id    text,
  people    integer,
  meetings  integer,
  moments   integer,
  phrasings integer,
  can_view_content boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with agg as (
    select
      o.gap_id,
      count(distinct o.asker_name)::integer        as people,
      count(distinct o.meeting_id)::integer        as meetings,
      count(*)::integer                            as moments,
      count(distinct o.verbatim_question)::integer as phrasings
    from public.gap_occurrences o
    where o.gap_id = any(p_gap_ids)
    group by o.gap_id
  )
  select
    g.gap_id,
    coalesce(a.people, 0),
    coalesce(a.meetings, 0),
    coalesce(a.moments, 0),
    coalesce(a.phrasings, 0),
    public.can_view_gap_content(g.gap_id) as can_view_content
  from unnest(p_gap_ids) as g(gap_id)
  left join agg a on a.gap_id = g.gap_id;
$$;

grant execute on function public.knowledge_gaps_stats(text[]) to authenticated, service_role;

-- Covering index for the grouped distinct-counts (gap_id leading so the
-- = any(...) filter and GROUP BY both use it). verbatim_question is deliberately
-- NOT included: it's unbounded text and a long question would blow the btree
-- index-row size cap and start failing occurrence INSERTs.
create index if not exists gap_occurrences_stats_idx
  on public.gap_occurrences (gap_id, meeting_id, asker_name);

-- The new index makes two originals redundant (write amplification on the gap
-- pipeline's hottest insert table):
--   gap_occurrences_gap_id_idx     — exact prefix of gap_occurrences_stats_idx
--   gap_occurrences_meeting_id_idx — exact prefix of the unique
--                                    (meeting_id, utterance_id) index
drop index if exists public.gap_occurrences_gap_id_idx;
drop index if exists public.gap_occurrences_meeting_id_idx;
