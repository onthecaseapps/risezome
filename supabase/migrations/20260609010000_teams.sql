-- Teams + team membership (teams restructure U1).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U1; KTD3, KTD8.
--
-- The Org stays the top-level tenancy + KMS boundary (org_id, unchanged). Teams
-- are a NEW membership unit WITHIN an org: a user belongs to one or more teams.
-- Teams are the unit people are actually put in, the browse lens, and (U3) the
-- source-selection unit. They do NOT replace org_id and carry no encryption role.
--
-- Writes (create/rename/archive, add/remove members) flow through admin-gated
-- service-role server actions (U7) — RLS here is READ-ONLY for members, with NO
-- client write policy (default-deny), mirroring the org_members / permission
-- discipline in 20260530090000 + 20260608*. The is_team_member() helper is
-- SECURITY DEFINER so policies (U3/U4) can call it without re-triggering the
-- org_members self-recursion fixed in 20260530110000.

------------------------------------------------------------
-- 1. teams + team_members
------------------------------------------------------------

create table public.teams (
  team_id     uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null references public.orgs(id) on delete cascade,
  name        text        not null,
  slug        text        not null,
  archived_at timestamptz,                       -- soft archive; archived teams drop out of switchers + contribute no sources
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, slug)
);

create index teams_org_id_idx on public.teams (org_id);

-- Many-to-many between users and teams. Composite PK doubles as the membership
-- lookup index; user_id index for the reverse "which teams is user X on" path
-- (hit when resolving a meeting's effective sources in U4).
create table public.team_members (
  team_id    uuid        not null references public.teams(team_id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index team_members_user_id_idx on public.team_members (user_id);

create trigger teams_set_updated_at
  before update on public.teams
  for each row
  execute function public.set_updated_at();

------------------------------------------------------------
-- 2. RLS — member reads, service-role writes (no client write policy)
------------------------------------------------------------

alter table public.teams        enable row level security;
alter table public.team_members enable row level security;

-- A user can read teams of orgs they belong to (so the team switcher + pickers
-- can render). Writes via service-role server actions only (KTD8).
create policy "members read their org's teams"
  on public.teams for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members
      where user_id = (select auth.uid())
    )
  );

-- A user can read team_members rows for teams in their orgs (so member pickers +
-- "who's on this team" render). Writes via service-role server actions only.
create policy "members read their org's team_members"
  on public.team_members for select
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
-- 3. is_team_member(team_id) — SECURITY DEFINER membership predicate
------------------------------------------------------------
-- Mirrors is_meeting_participant / is_org_admin (20260603320000 / 20260608010000):
-- reads team_members OUTSIDE RLS (security definer + pinned search_path) so the
-- policies that call it never re-trigger org_members recursion. auth.uid() still
-- resolves from the request JWT.

create or replace function public.is_team_member(p_team_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id
      and user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_team_member(uuid) from public;
grant execute on function public.is_team_member(uuid) to authenticated;

------------------------------------------------------------
-- 4. Default-team backfill (A-R15)
------------------------------------------------------------
-- Every existing org gets one default team ("General") seeded with ALL its
-- current members, so the org+teams shape is non-empty on cutover and U3's
-- team_sources backfill has a team to attach existing sources to. Idempotent:
-- re-running inserts nothing new (unique(org_id, slug) + PK conflicts no-op).

insert into public.teams (org_id, name, slug)
select id, 'General', 'general'
from public.orgs
on conflict (org_id, slug) do nothing;

insert into public.team_members (team_id, user_id)
select t.team_id, om.user_id
from public.teams t
join public.org_members om on om.org_id = t.org_id
where t.slug = 'general'
on conflict (team_id, user_id) do nothing;
