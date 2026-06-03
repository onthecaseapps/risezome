------------------------------------------------------------
-- Knowledge Gaps — RLS policies (plan U2)
--   docs/plans/2026-06-02-002-feat-knowledge-gaps-plan.md
--
-- Visibility model (KTD1): a gap is visible to a user when ANY of:
--   - it is shared_with_org and the user is a member of the org, OR
--   - the user is the assignee, OR
--   - the user is a manager of the org (curation needs library-wide sight), OR
--   - the user is in the gap's gap_viewers list (seeded from meeting participants).
--
-- The predicate runs as a SECURITY DEFINER helper so policies never recurse
-- into org_members'/gap_viewers' own SELECT policies (the 20260530110000 /
-- 20260603300000 hazard). auth.uid() still resolves from the request JWT.
------------------------------------------------------------

create function public.can_view_gap(p_gap_id text)
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
        or public.is_org_manager(g.org_id)
        or exists (
          select 1 from public.gap_viewers v
          where v.gap_id = g.gap_id
            and v.user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function public.can_view_gap(text) from public;
grant execute on function public.can_view_gap(text) to authenticated;

------------------------------------------------------------
-- knowledge_gaps
------------------------------------------------------------

-- SELECT: viewer-ACL per KTD1.
create policy "view gaps you can see"
  on public.knowledge_gaps for select
  to authenticated
  using (public.can_view_gap(gap_id));

-- UPDATE: a manager (any curation) or the assignee (resolve/dismiss their own).
-- Column-level scoping (assignee may change status but not assignment/section)
-- is enforced in the manager-gated server actions, not RLS — acceptable
-- pre-launch since the only client write path is those actions.
create policy "managers and assignees update gaps"
  on public.knowledge_gaps for update
  to authenticated
  using (public.is_org_manager(org_id) or assignee_id = (select auth.uid()))
  with check (public.is_org_manager(org_id) or assignee_id = (select auth.uid()));

-- No INSERT/DELETE policy: gaps are created by the assembly job and deleted by
-- the manual merge action, both via the service role.

------------------------------------------------------------
-- gap_occurrences / gap_viewers — visible iff the parent gap is visible
------------------------------------------------------------

create policy "view occurrences of visible gaps"
  on public.gap_occurrences for select
  to authenticated
  using (public.can_view_gap(gap_id));

create policy "view viewers of visible gaps"
  on public.gap_viewers for select
  to authenticated
  using (public.can_view_gap(gap_id));

------------------------------------------------------------
-- knowledge_gap_sections — readable by org members, curated by managers
------------------------------------------------------------

create policy "members read their org's gap sections"
  on public.knowledge_gap_sections for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

create policy "managers insert gap sections"
  on public.knowledge_gap_sections for insert
  to authenticated
  with check (public.is_org_manager(org_id));

create policy "managers update gap sections"
  on public.knowledge_gap_sections for update
  to authenticated
  using (public.is_org_manager(org_id))
  with check (public.is_org_manager(org_id));

create policy "managers delete gap sections"
  on public.knowledge_gap_sections for delete
  to authenticated
  using (public.is_org_manager(org_id));

------------------------------------------------------------
-- notifications — a user reads and marks read only their own
------------------------------------------------------------

create policy "read your own notifications"
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "mark your own notifications read"
  on public.notifications for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No client INSERT policy: notifications are created by the assembly job /
-- assign action via the service role.

-- meeting_gap_misses intentionally has NO client policies — it is a
-- service-role-only staging table (RLS enabled in U1 => deny-all to clients).
