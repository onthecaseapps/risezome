-- Last-manager invariant as a DB-level backstop (plan U8 / R11).
-- (Plan: docs/plans/2026-06-01-001-feat-workspace-invitations-roles-plan.md)
--
-- The member-management action checks the manager count before demoting or
-- removing, but a read-then-write check is racy: two concurrent demotes can
-- each observe two managers and both proceed, leaving the org with zero. This
-- trigger makes the invariant atomic — it locks the org's remaining manager
-- rows (FOR UPDATE) so concurrent demote/remove operations serialize, then
-- aborts if the operation would drop the manager count to zero.

create function public.enforce_last_manager()
  returns trigger
  language plpgsql
  as $$
declare
  remaining int;
begin
  if (TG_OP = 'DELETE' and OLD.role = 'manager')
     or (TG_OP = 'UPDATE' and OLD.role = 'manager' and NEW.role <> 'manager') then
    select count(*) into remaining
    from (
      select 1
      from public.org_members
      where org_id = OLD.org_id
        and role = 'manager'
        and user_id <> OLD.user_id
      for update
    ) other_managers;
    if remaining = 0 then
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

create trigger org_members_last_manager
  before update or delete on public.org_members
  for each row
  execute function public.enforce_last_manager();
