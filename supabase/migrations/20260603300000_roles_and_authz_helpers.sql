-- Workspace roles + bot-invite grant + recursion-safe authorization helpers.
-- (Plan U1: docs/plans/2026-06-01-001-feat-workspace-invitations-roles-plan.md)
--
-- Foundation for multi-person workspaces:
--   * org_members.role becomes a two-value vocabulary ('manager' | 'member').
--     Existing creators were stored as 'admin'; backfilled to 'manager' so the
--     DB and UI share one word. A CHECK pins the allowed values (a grep at plan
--     time confirmed no other role value is stored anywhere in the codebase).
--   * org_members.can_invite_bot: a per-member grant, separate from role, that
--     lets a plain member launch the bot into their own meetings. Default false;
--     managers are implicitly allowed (see is_org_manager()).
--   * SECURITY DEFINER helpers (is_org_manager, org_member_ids) read org_members
--     OUTSIDE RLS so role-aware policies (added in later units) never re-trigger
--     the org_members self-recursion bug fixed in 20260530110000.
--
-- org_members keeps ZERO user-facing UPDATE policies: every write (role change,
-- grant toggle, removal) goes through a service-role server action with an
-- explicit manager check, so a member cannot self-set can_invite_bot = true.

------------------------------------------------------------
-- Schema
------------------------------------------------------------

alter table public.org_members
  add column can_invite_bot boolean not null default false;

-- Vocabulary unification: existing workspace creators were 'admin'.
update public.org_members set role = 'manager' where role = 'admin';

alter table public.org_members
  add constraint org_members_role_check check (role in ('manager', 'member'));

------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER — bypass RLS to avoid recursion)
------------------------------------------------------------

-- True when the calling user is a manager of p_org_id. Reads org_members
-- outside RLS (SECURITY DEFINER) so policies that call it never recurse into
-- org_members' own SELECT policy (the 20260530110000 hazard). auth.uid() still
-- resolves from the request JWT inside a definer function.
create function public.is_org_manager(p_org_id uuid)
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
      and role = 'manager'
  );
$$;

-- Member user_ids of p_org_id, returned only when the caller is themselves a
-- member of that org (otherwise no rows). Lets a manager's member-list read the
-- full membership set without re-triggering the org_members recursion bug.
create function public.org_member_ids(p_org_id uuid)
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select m.user_id
  from public.org_members m
  where m.org_id = p_org_id
    and exists (
      select 1 from public.org_members caller
      where caller.org_id = p_org_id
        and caller.user_id = (select auth.uid())
    );
$$;

revoke all on function public.is_org_manager(uuid) from public;
revoke all on function public.org_member_ids(uuid) from public;
grant execute on function public.is_org_manager(uuid) to authenticated;
grant execute on function public.org_member_ids(uuid) to authenticated;
