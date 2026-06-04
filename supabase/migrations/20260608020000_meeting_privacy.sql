-- Meeting privacy level + org privacy config + floor enforcement
-- (permissions overhaul U2; KTD6, KTD7).
-- Plan: docs/plans/2026-06-04-004-feat-permissions-overhaul-plan.md — U2.
--
-- Adds the first per-meeting privacy control:
--
--   only_me          — only the owner (and, later, the super_admin master key)
--   only_participants — the owner + meeting participants
--   only_teammates    — every member of the org (the library-by-default value)
--
-- Privacy ordering (rank): only_me=0 (most private) < only_participants=1 <
-- only_teammates=2 (least private). The org "privacy floor" is the MOST private
-- level a normal write may pick; a write whose level is MORE private than the
-- floor (rank(level) < rank(floor)) is rejected by the BEFORE INSERT/UPDATE
-- trigger below.
--
-- This migration only builds the SCHEMA + the floor trigger + the config table.
-- The privacy-aware RLS rewrite (can_access_meeting) lands in U3; the write
-- actions land in U4. The org default is stamped onto new meetings at creation
-- time by launch-bot.ts (service-role).
--
-- ── FLOOR BYPASS MECHANISM (read this, U4) ───────────────────────────────────
-- The floor trigger enforces the floor for ALL writes EXCEPT when the current
-- transaction has set the session-local GUC `app.bypass_privacy_floor` to 'on':
--
--     set local app.bypass_privacy_floor = 'on';
--
-- `set local` confines the override to the CURRENT TRANSACTION, so it can never
-- leak to another statement on a pooled connection. The admin-override write
-- path (U4) MUST issue this inside the same transaction as its UPDATE — e.g. via
-- a SECURITY DEFINER function or an explicit transaction block — so an admin can
-- set a meeting below the org floor while a normal owner cannot. The trigger
-- reads it with `current_setting('app.bypass_privacy_floor', true)` (the `true`
-- = missing_ok, so an unset GUC yields NULL rather than erroring). Nothing sets
-- this GUC today, so the floor is fully enforced until U4 wires the override.
--
-- KTD6 — org_privacy_config is service-role-write-only: RLS enabled, an
-- org-member SELECT policy (so the app can read the floor/default for the
-- picker), and NO client write policy (default-deny). All writes flow through a
-- hardened admin-gated service-role action (U4), mirroring the secret-table
-- shape (org_encryption_keys) and the service-role-only write discipline.

------------------------------------------------------------
-- 1. meetings.privacy_level (+ backfill, R14)
------------------------------------------------------------
-- New column defaults to 'only_teammates' so the ALTER stamps every existing
-- row to the library-by-default value in a single pass (R14). The explicit
-- UPDATE below is belt-and-suspenders for any row a concurrent insert might add
-- between the ALTER and commit (there are none in practice, but it documents the
-- backfill intent and is idempotent).

alter table public.meetings
  add column if not exists privacy_level text not null default 'only_teammates'
    check (privacy_level in ('only_me', 'only_participants', 'only_teammates'));

-- Explicit backfill of any pre-existing rows (R14). The column default already
-- covers rows present at ALTER time; this guarantees no NULL/blank slips through.
update public.meetings
set privacy_level = 'only_teammates'
where privacy_level is null;

------------------------------------------------------------
-- 2. org_privacy_config (KTD6)
------------------------------------------------------------
-- Per-org privacy defaults. One row per org:
--   default_privacy — stamped onto NEW meetings at creation (launch-bot.ts).
--   privacy_floor   — the most-private level a normal write may pick.
-- Both shipped at the library-by-default posture: default_privacy='only_teammates'
-- (new meetings are workspace-visible) and privacy_floor='only_me' (members may
-- dial all the way down to private — the floor is permissive until an admin
-- raises it via U4).

create table public.org_privacy_config (
  org_id          uuid        primary key references public.orgs(id) on delete cascade,
  default_privacy text        not null default 'only_teammates'
                              check (default_privacy in ('only_me', 'only_participants', 'only_teammates')),
  privacy_floor   text        not null default 'only_me'
                              check (privacy_floor in ('only_me', 'only_participants', 'only_teammates')),
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);

alter table public.org_privacy_config enable row level security;

-- Org members may READ their org's privacy config (the picker needs the floor +
-- default). NO write policy: writes are service-role only (KTD6).
create policy "members read their org's privacy config"
  on public.org_privacy_config for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

create trigger org_privacy_config_set_updated_at
  before update on public.org_privacy_config
  for each row
  execute function public.set_updated_at();

-- Seed a default config row for every existing org (idempotent). New orgs get
-- their row from the onboarding/config action; the floor trigger falls back to
-- the table defaults when no row exists, so a missing row is never a foot-gun.
insert into public.org_privacy_config (org_id)
select id from public.orgs
on conflict (org_id) do nothing;

------------------------------------------------------------
-- 3. Privacy-rank helper (reused by the floor trigger + U3/U4)
------------------------------------------------------------
-- Maps a privacy level to its rank. IMMUTABLE (pure mapping) so it is usable in
-- expressions/indexes and the planner can fold it. Returns NULL for an unknown
-- value (the CHECKs already forbid those, so callers never see NULL in practice).

create function public.meeting_privacy_rank(p_level text)
  returns int
  language sql
  immutable
  as $$
  select case p_level
    when 'only_me' then 0
    when 'only_participants' then 1
    when 'only_teammates' then 2
    else null
  end;
$$;

------------------------------------------------------------
-- 4. Floor-enforcement trigger (KTD7)
------------------------------------------------------------
-- BEFORE INSERT OR UPDATE on meetings: reject a privacy_level that is MORE
-- private than the org's floor (rank(new) < rank(floor)) UNLESS the transaction
-- has set app.bypass_privacy_floor='on' (the admin-override escape hatch — see
-- header). On UPDATE the check only runs when privacy_level actually changes, so
-- ordinary status/recall_bot_id updates are never floor-checked. If the org has
-- no config row, the floor defaults to 'only_me' (rank 0) — i.e. unconstrained.

create function public.enforce_meeting_privacy_floor()
  returns trigger
  language plpgsql
  as $$
declare
  floor_level text;
  floor_rank int;
  level_rank int;
begin
  -- Skip when privacy_level is unchanged on UPDATE (avoid floor-checking every
  -- unrelated status write, and let an admin override raise it later).
  if TG_OP = 'UPDATE' and NEW.privacy_level is not distinct from OLD.privacy_level then
    return NEW;
  end if;

  -- Admin-override escape hatch (U4): a transaction-local GUC bypasses the floor.
  if current_setting('app.bypass_privacy_floor', true) = 'on' then
    return NEW;
  end if;

  select privacy_floor into floor_level
  from public.org_privacy_config
  where org_id = NEW.org_id;

  -- No config row => unconstrained floor (most permissive: only_me).
  floor_level := coalesce(floor_level, 'only_me');
  floor_rank := public.meeting_privacy_rank(floor_level);
  level_rank := public.meeting_privacy_rank(NEW.privacy_level);

  if level_rank < floor_rank then
    raise exception
      'meeting privacy_level % is more private than the org floor %',
      NEW.privacy_level, floor_level
      using errcode = 'check_violation';
  end if;

  return NEW;
end;
$$;

create trigger meetings_enforce_privacy_floor
  before insert or update on public.meetings
  for each row
  execute function public.enforce_meeting_privacy_floor();
