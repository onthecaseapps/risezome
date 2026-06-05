-- Source-filtered search RPCs + meeting effective-source resolver (U4; KTD5).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U4.
--
-- search_corpus_vector / search_corpus_fts gain an optional p_source_ids uuid[]:
--   * NULL  -> no source filter (back-compat: the retrieval debug page passes no
--             source set and still searches the whole org corpus).
--   * array -> restrict to chunks whose denormalized source_id is in the set.
-- org_id stays as defense-in-depth alongside the source filter.
--
-- meeting_effective_source_ids(meeting_id) resolves a meeting's effective source
-- set: the union of team_sources over the ORG-MEMBER attendees' (non-archived)
-- teams. Non-org-member guests contribute nothing. The bot-worker calls this once
-- per meeting and passes the result as p_source_ids (B-R8/B-R9).

------------------------------------------------------------
-- 1. search_corpus_vector(+ p_source_ids)
------------------------------------------------------------
create or replace function public.search_corpus_vector(
  p_org_id uuid,
  p_query_vector text,
  p_limit int default 20,
  p_source_ids uuid[] default null
)
returns table (chunk_id text, distance double precision)
language sql
security invoker
stable
as $$
  select c.chunk_id, (c.embedding <=> p_query_vector::vector)::double precision as distance
  from public.corpus_chunk_embeddings c
  where c.org_id = p_org_id
    and (p_source_ids is null or c.source_id = any(p_source_ids))
  order by c.embedding <=> p_query_vector::vector
  limit p_limit;
$$;

------------------------------------------------------------
-- 2. search_corpus_fts(+ p_source_ids)
------------------------------------------------------------
create or replace function public.search_corpus_fts(
  p_org_id uuid,
  p_query text,
  p_limit int default 20,
  p_source_ids uuid[] default null
)
returns table (chunk_id text, rank double precision)
language sql
security invoker
stable
as $$
  select dc.chunk_id, ts_rank(dc.text_fts, q)::double precision as rank
  from public.doc_chunks dc, websearch_to_tsquery('english', p_query) q
  where dc.org_id = p_org_id
    and dc.text_fts @@ q
    and (p_source_ids is null or dc.source_id = any(p_source_ids))
  order by ts_rank(dc.text_fts, q) desc
  limit p_limit;
$$;

-- Re-grant (the 3-arg signatures still exist via defaults; grant the new arity).
grant execute on function public.search_corpus_vector(uuid, text, int, uuid[]) to authenticated;
grant execute on function public.search_corpus_fts(uuid, text, int, uuid[]) to authenticated;

------------------------------------------------------------
-- 3. meeting_effective_source_ids(meeting_id) — the retrieval source set (B-R8)
------------------------------------------------------------
-- SECURITY DEFINER so it resolves membership/teams outside RLS (the bot-worker
-- calls it via service-role; an authed client may also call it for its own
-- meetings). Returns the DISTINCT union of team_sources over the org-member
-- attendees' non-archived teams. Empty set => the meeting retrieves nothing from
-- the corpus (B-R9).

create or replace function public.meeting_effective_source_ids(p_meeting_id uuid)
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select distinct ts.source_id
  from public.meetings m
  join public.meeting_participants mp on mp.meeting_id = m.meeting_id
  join public.org_members om on om.org_id = m.org_id and om.user_id = mp.user_id
  join public.team_members tm on tm.user_id = mp.user_id
  join public.teams t on t.team_id = tm.team_id and t.org_id = m.org_id and t.archived_at is null
  join public.team_sources ts on ts.team_id = t.team_id
  where m.meeting_id = p_meeting_id;
$$;

revoke all on function public.meeting_effective_source_ids(uuid) from public;
grant execute on function public.meeting_effective_source_ids(uuid) to authenticated;
