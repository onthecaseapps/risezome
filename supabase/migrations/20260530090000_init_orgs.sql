-- U1: Initial multi-tenant foundation. Every other table in the schema
-- references orgs(id) and uses an org_id-based RLS policy that joins
-- through org_members. This migration is the keystone — get it wrong and
-- every subsequent unit inherits the bug.

------------------------------------------------------------
-- Tables
------------------------------------------------------------

create table public.orgs (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  created_at  timestamptz not null default now()
);

-- Many-to-many between users and orgs. The composite PK (org_id, user_id)
-- doubles as the lookup index for the "is user X a member of org Y"
-- predicate that every other RLS policy joins through.
create table public.org_members (
  org_id     uuid        not null references public.orgs(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  role       text        not null default 'member',
  joined_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- The reverse lookup ("which orgs does user X belong to") is hit on every
-- authed page render via requireAuthedUserWithOrg(). user_id is already
-- indexed by the PK's secondary path on Postgres 15+, but make it explicit
-- so future readers don't have to remember that.
create index org_members_user_id_idx on public.org_members (user_id);

------------------------------------------------------------
-- RLS
------------------------------------------------------------

alter table public.orgs        enable row level security;
alter table public.org_members enable row level security;

-- The `(select auth.uid())` subquery wrapping is load-bearing: per-statement
-- caching makes the policy ~20x faster than bare auth.uid() at non-trivial
-- table sizes. See Supabase RLS perf docs.

-- Orgs: a user can read orgs they belong to, full stop. Writes go through
-- service-role-backed server actions; no user-facing INSERT/UPDATE/DELETE.
create policy "members read their orgs"
  on public.orgs for select
  to authenticated
  using (
    id in (
      select org_id from public.org_members
      where user_id = (select auth.uid())
    )
  );

-- Org members: a user can read membership rows for orgs they belong to
-- (so the org switcher in U3 can show co-members later). Writes via
-- service-role server actions only.
create policy "members read their org_members"
  on public.org_members for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members
      where user_id = (select auth.uid())
    )
  );
