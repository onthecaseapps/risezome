-- team_sources: per-team source selection (teams restructure U3).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U3; KTD3, KTD4, KTD8.
--
-- Sources move from org-scoped to TEAM-scoped SELECTION. The canonical corpus
-- (sources/docs/doc_chunks/corpus_chunk_embeddings) stays org-level and is NOT
-- denormalized with team_id (KTD3) — this junction is the only new selection
-- state. Many teams may select one source (shared => indexed once); a team may
-- select many sources. The reference count of a source = the number of teams
-- selecting it; the index/de-index lifecycle (app/_lib/team-source-lifecycle.ts,
-- U3) keys on it: first reference indexes, last drop marks the source 'removed'
-- (the existing purge-removed-sources cron then hard-deletes after a grace
-- window — KTD4).
--
-- Writes flow through admin-gated service-role actions (U7). RLS here is members-
-- read-only for their org's teams; NO client write policy (KTD8).

------------------------------------------------------------
-- 1. team_sources
------------------------------------------------------------

create table public.team_sources (
  team_id    uuid        not null references public.teams(team_id) on delete cascade,
  source_id  uuid        not null references public.sources(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, source_id)
);

-- Reverse lookup ("which teams select source X") drives the reference count and
-- the meeting-time effective-source resolution (U4).
create index team_sources_source_id_idx on public.team_sources (source_id);

------------------------------------------------------------
-- 2. RLS — member reads, service-role writes (no client write policy)
------------------------------------------------------------

alter table public.team_sources enable row level security;

-- A user can read team_sources for teams in orgs they belong to (so the source
-- picker + team views render). Writes via service-role server actions only.
create policy "members read their org's team_sources"
  on public.team_sources for select
  to authenticated
  using (
    team_id in (
      select t.team_id from public.teams t
      where t.org_id in (
        select org_id from public.org_members
        where user_id = (select auth.uid())
      )
    )
  );

------------------------------------------------------------
-- 3. Backfill existing sources to each org's default team (B-R11)
------------------------------------------------------------
-- Every live (non-removed) source is attached to its org's default "general"
-- team, so nothing de-indexes on cutover and current retrieval behavior is
-- preserved until admins split sources across real teams. Idempotent.

insert into public.team_sources (team_id, source_id)
select t.team_id, s.id
from public.sources s
join public.teams t on t.org_id = s.org_id and t.slug = 'general'
where s.removed_at is null
on conflict (team_id, source_id) do nothing;
