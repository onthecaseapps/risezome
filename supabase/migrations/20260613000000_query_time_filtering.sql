-- Query-time corpus filtering (per-team views of a shared source).
-- Plan: docs/plans/2026-06-11-001-feat-query-time-filtering-plan.md (U1).
--
-- Adds the schema for: a per-team VIEW policy (what a team may retrieve), a
-- per-chunk VISIBILITY set (the teams whose view admits the chunk's document,
-- computed at index time), and a helper resolving a meeting's attending teams.
-- Retrieval (a later unit) filters chunks by `visible_team_ids && <attending
-- teams>`. Columns default safe: view_policy null = inherit; visible_team_ids
-- '{}' = invisible until the corpus is (re)stamped by the indexer backfill (U7),
-- so the query-time predicate must stay gated until that backfill runs.

------------------------------------------------------------
-- 1. Per-team view policy (what the filter editor edits going forward)
------------------------------------------------------------
-- Mirrors CorpusPolicy (preset + custom rules). NULL = inherit the org default.
-- The source-level sources.corpus_policy becomes a default a team's view
-- inherits from; the per-team view is the new source of truth for retrieval.
alter table public.team_sources
  add column view_policy jsonb;

-- Preserve current behavior on cutover: each team inherits the source's existing
-- policy as its initial view, so retrieval is unchanged until a team edits it.
update public.team_sources ts
  set view_policy = s.corpus_policy
  from public.sources s
  where s.id = ts.source_id and s.corpus_policy is not null;

------------------------------------------------------------
-- 2. Per-chunk visibility (denormalized onto the search tables, like source_id)
------------------------------------------------------------
-- The set of team ids (as text) whose view-policy admits this chunk's document.
-- A document is stored iff this set is non-empty (the minimal union). Empty
-- default => invisible to every team until stamped by the indexer backfill.
-- text[] (not uuid[]) so the direct-Postgres writer inserts JS string arrays
-- without per-row casts; retrieval passes the attending team ids as text too.
alter table public.doc_chunks
  add column visible_team_ids text[] not null default '{}';
alter table public.corpus_chunk_embeddings
  add column visible_team_ids text[] not null default '{}';

-- GIN indexes for the `&&` overlap predicate the search RPCs will add.
create index doc_chunks_visible_team_ids_idx
  on public.doc_chunks using gin (visible_team_ids);
create index corpus_chunk_embeddings_visible_team_ids_idx
  on public.corpus_chunk_embeddings using gin (visible_team_ids);

------------------------------------------------------------
-- 3. meeting_attendee_team_ids(meeting_id) — the attending teams for a meeting
------------------------------------------------------------
-- The non-archived teams the meeting's org-member participants belong to. Used
-- by retrieval to intersect with each chunk's visible_team_ids. SECURITY DEFINER
-- (bypasses RLS); service-role only, mirroring meeting_effective_source_ids.
-- This is that function minus the team_sources leg (teams, not sources).
create or replace function public.meeting_attendee_team_ids(p_meeting_id uuid)
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select distinct t.team_id
  from public.meetings m
  join public.meeting_participants mp on mp.meeting_id = m.meeting_id
  join public.org_members om on om.org_id = m.org_id and om.user_id = mp.user_id
  join public.team_members tm on tm.user_id = mp.user_id
  join public.teams t on t.team_id = tm.team_id and t.org_id = m.org_id and t.archived_at is null
  where m.meeting_id = p_meeting_id;
$$;

revoke execute on function public.meeting_attendee_team_ids(uuid) from public, anon, authenticated;
