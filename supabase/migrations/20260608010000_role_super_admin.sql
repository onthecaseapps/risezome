-- Super Admin role tier + admin-power abstraction (permissions overhaul U1).
-- (Plan: docs/plans/2026-06-04-004-feat-permissions-overhaul-plan.md — U1;
--  KTD1, KTD2, KTD8.)
--
-- Adds the third role tier on top of the existing 'manager' | 'member'
-- vocabulary WITHOUT renaming anything (KTD1): the stored value 'manager'
-- remains the "Admin" tier (the UI labels it "Admin"); we only add a new
-- 'super_admin' tier above it. So:
--
--   member       — standard user
--   manager       — Admin tier (org settings, member mgmt, config, privacy floor)
--   super_admin   — all Admin powers PLUS the audited master key (added later)
--
-- KTD2 — Admin-power gate = is_org_admin() = role in ('manager','super_admin'),
-- so super_admin inherits every admin power. is_org_manager() is LEFT UNCHANGED
-- for back-compat but is no longer used by admin-power gates (every admin-power
-- RLS policy is repointed below). is_super_admin() = role = 'super_admin' is the
-- narrow gate reserved for the master-key bypass + audit-log read (later units).
--
-- KTD8 — Generalize the last-privileged-user invariant. The existing trigger
-- forbade dropping an org to zero managers; we keep that (an org needs >=1
-- admin-or-above) AND additionally forbid dropping an org to zero super_admins
-- (the master-key holder must always exist, per requirement R15/Q1). Both checks
-- lock the surviving rows FOR UPDATE so concurrent demote/remove operations
-- serialize (same atomic pattern as the original).
--
-- Backfill rule (R15): seed each org's CREATOR as super_admin. The creator is
-- modelled as the earliest-joined 'manager' in the org (the onboarding action
-- inserts the creator as the org's first member, with role 'manager'). For each
-- org that has NO super_admin yet, we promote exactly that one earliest-joined
-- manager row to 'super_admin'. This is idempotent (orgs that already have a
-- super_admin are skipped) so it is safe on a fresh DB where the new onboarding
-- action already seeds the creator as super_admin, and on the existing DB where
-- every org currently has only managers/members. Every org ends with >=1
-- super_admin (an org always has at least one manager, by the prior invariant).

------------------------------------------------------------
-- 1. Role vocabulary: add 'super_admin'
------------------------------------------------------------

alter table public.org_members
  drop constraint org_members_role_check;

alter table public.org_members
  add constraint org_members_role_check
  check (role in ('member', 'manager', 'super_admin'));

------------------------------------------------------------
-- 2. Authorization helpers (SECURITY DEFINER — same shape/grants as
--    is_org_manager: bypass RLS to avoid the org_members self-recursion bug
--    fixed in 20260530110000; auth.uid() still resolves from the request JWT).
------------------------------------------------------------

-- True when the caller has ADMIN POWER in p_org_id: role is 'manager' (the
-- stored Admin tier) OR 'super_admin' (which inherits all admin powers). This
-- is the canonical admin-power gate going forward (KTD2).
create or replace function public.is_org_admin(p_org_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where org_id = p_org_id
      and user_id = (select auth.uid())
      and role in ('manager', 'super_admin')
  );
$$;

-- True only when the caller is a super_admin of p_org_id. Reserved for the
-- master-key bypass and audit-log read (later units); not an admin-power gate.
create or replace function public.is_super_admin(p_org_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.org_members
    where org_id = p_org_id
      and user_id = (select auth.uid())
      and role = 'super_admin'
  );
$$;

revoke all on function public.is_org_admin(uuid) from public;
revoke all on function public.is_super_admin(uuid) from public;
grant execute on function public.is_org_admin(uuid) to authenticated;
grant execute on function public.is_super_admin(uuid) to authenticated;

------------------------------------------------------------
-- 3. Generalize the last-privileged-user invariant (KTD8)
------------------------------------------------------------
-- Replace enforce_last_manager() so that, on a demote/remove, the org must be
-- left with BOTH:
--   * at least one super_admin (the master-key holder — R15/Q1), AND
--   * at least one admin-or-above (super_admin or manager — an org needs an
--     admin to run settings/member mgmt).
-- A super_admin survivor also satisfies the admin-or-above requirement, so the
-- second check is only binding when the last manager is leaving while a
-- super_admin remains (fine) or when the last admin-or-above would leave (block).
-- Each count locks the surviving rows FOR UPDATE to serialize concurrent writes.
--
-- NOTE (test-harness gotcha): because this trigger now also blocks dropping the
-- last super_admin, an RLS test's afterAll cleanup that deletes the org's sole
-- super_admin row will be REJECTED. That is expected — tests should demote-then-
-- delete or accept the documented residue (the orphan org row left behind).

create or replace function public.enforce_last_manager()
  returns trigger
  language plpgsql
  as $$
declare
  remaining_super_admins int;
  remaining_admins int;
  loses_super_admin boolean;
  loses_admin boolean;
begin
  -- Does this op remove a super_admin from the org? (delete of a super_admin,
  -- or update of a super_admin to a non-super_admin role)
  loses_super_admin :=
    (TG_OP = 'DELETE' and OLD.role = 'super_admin')
    or (TG_OP = 'UPDATE' and OLD.role = 'super_admin' and NEW.role <> 'super_admin');

  -- Does this op remove an admin-or-above from the org? (delete of a
  -- manager/super_admin, or update of one down to plain 'member')
  loses_admin :=
    (TG_OP = 'DELETE' and OLD.role in ('manager', 'super_admin'))
    or (TG_OP = 'UPDATE' and OLD.role in ('manager', 'super_admin')
        and NEW.role not in ('manager', 'super_admin'));

  if loses_super_admin then
    select count(*) into remaining_super_admins
    from (
      select 1
      from public.org_members
      where org_id = OLD.org_id
        and role = 'super_admin'
        and user_id <> OLD.user_id
      for update
    ) others;
    if remaining_super_admins = 0 then
      raise exception 'cannot remove or demote the last super_admin of a workspace'
        using errcode = 'check_violation';
    end if;
  end if;

  if loses_admin then
    select count(*) into remaining_admins
    from (
      select 1
      from public.org_members
      where org_id = OLD.org_id
        and role in ('manager', 'super_admin')
        and user_id <> OLD.user_id
      for update
    ) others;
    if remaining_admins = 0 then
      raise exception 'cannot remove or demote the last manager of a workspace'
        using errcode = 'check_violation';
    end if;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

-- Trigger object org_members_last_manager already exists from 20260603350000
-- and points at enforce_last_manager(); the CREATE OR REPLACE above rebinds the
-- body in place, so no trigger DDL change is needed.

------------------------------------------------------------
-- 4. Backfill: seed each org's creator as super_admin (R15)
------------------------------------------------------------
-- For every org that does not yet have a super_admin, promote its earliest-
-- joined manager (the creator) to super_admin. Idempotent + fresh-DB safe.

update public.org_members m
set role = 'super_admin'
where m.role = 'manager'
  and not exists (
    select 1 from public.org_members sa
    where sa.org_id = m.org_id
      and sa.role = 'super_admin'
  )
  and m.user_id = (
    select m2.user_id
    from public.org_members m2
    where m2.org_id = m.org_id
      and m2.role = 'manager'
    order by m2.joined_at asc, m2.user_id asc
    limit 1
  );

------------------------------------------------------------
-- 5. Repoint admin-power RLS policies from is_org_manager -> is_org_admin (KTD2)
------------------------------------------------------------
-- Every LIVE policy/helper that gates an "admin power" is recreated to call
-- is_org_admin so super_admin inherits the power. is_org_manager is left defined
-- (back-compat) but is no longer referenced by any admin gate. None of these
-- surfaces are intended to be manager-but-not-super_admin.
--
-- Sites repointed (all from 20260603330000 / 20260606030000; the
-- knowledge_gap_sections manager-write policies that also used is_org_manager
-- were already dropped in 20260607080000, so there is nothing to repoint there):
--   * org_members SELECT "read own membership or all as manager"
--       — an admin reading the full roster; super_admin must see it too.
--   * sources SELECT "managers read their org's sources"
--       — /sources is an admin-only surface; super_admin must see it too.
--   * workspace_bot_settings INSERT/UPDATE upsert
--       — admin org-config write; super_admin must be able to write it too.
--   * can_view_gap() helper's "is_org_manager(g.org_id)" branch
--       — admin library-wide curation sight; super_admin must have it too.

-- org_members: own row always; all org rows for an admin (manager OR super_admin)
drop policy if exists "read own membership or all as manager" on public.org_members;
create policy "read own membership or all as admin"
  on public.org_members for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_org_admin(org_id)
  );

-- sources: admin-only read surface
drop policy if exists "managers read their org's sources" on public.sources;
create policy "admins read their org's sources"
  on public.sources for select
  to authenticated
  using (public.is_org_admin(org_id));

-- workspace_bot_settings: admin config writes
drop policy if exists "managers upsert workspace bot settings (insert)" on public.workspace_bot_settings;
create policy "admins upsert workspace bot settings (insert)"
  on public.workspace_bot_settings for insert
  to authenticated
  with check (public.is_org_admin(org_id));

drop policy if exists "managers upsert workspace bot settings (update)" on public.workspace_bot_settings;
create policy "admins upsert workspace bot settings (update)"
  on public.workspace_bot_settings for update
  to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- can_view_gap(): repoint the admin-curation branch to is_org_admin so a
-- super_admin gets the same library-wide gap sight a manager already has.
-- (Body is identical to 20260606030000 except is_org_manager -> is_org_admin.)
create or replace function public.can_view_gap(p_gap_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
    from public.knowledge_gaps g
    where g.gap_id = p_gap_id
      and (
        (
          g.shared_with_org
          and g.org_id in (
            select org_id from public.org_members where user_id = (select auth.uid())
          )
        )
        or g.assignee_id = (select auth.uid())
        or public.is_org_admin(g.org_id)
        or exists (
          select 1 from public.gap_viewers v
          where v.gap_id = g.gap_id
            and v.user_id = (select auth.uid())
        )
      )
  );
$$;
