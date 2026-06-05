-- Knowledge-gap visibility -> attendees + master key; metadata-only assignment
-- (teams restructure U5; KTD6).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U5.
--
-- The teams model makes gaps ATTENDEES-ONLY (R7) with org-wide QUESTION
-- ASSIGNMENT that exposes NO verbatim to the assignee (R8/AE3). Two changes:
--
-- 1) can_view_gap drops the `assignee_id` branch. Previously being assigned a gap
--    granted full visibility (the gap row + gap_occurrences verbatim + asker). In
--    the new model assignment is metadata-only, so the assignee path is removed
--    here and the assignment action (gap-actions.ts) no longer seeds gap_viewers.
--
-- 2) The blanket admin branch is tightened from is_org_manager to is_super_admin.
--    Per R7/R9/R11/AE4 gaps are attendees-only and only the SUPER-ADMIN MASTER KEY
--    sees gaps it didn't contribute to — a plain Admin (manager) does NOT get
--    blanket gap access (they see only gaps they attended / were shared). This is
--    the gap analogue of can_access_meeting's attendees ∪ super-admin (U2).
--    (The plan text said "keep is_org_admin"; AE4 + R9 require master-key-only, so
--    is_super_admin is the faithful reading.)
--
-- Retained: shared_with_org (+ org member), participant-seeded gap_viewers.
--
-- NOTE (audit): a super_admin reading a gap they didn't contribute to is a
-- master-key access; like the meeting master key it is not audited at the RLS
-- layer (an RLS SELECT can't append a row). This matches the shipped posture
-- (the prior manager branch was likewise unaudited) and is even narrower now.

------------------------------------------------------------
-- 1. can_view_gap -> attendees (shared/gap_viewers) ∪ super-admin master key
------------------------------------------------------------
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
        -- Shared org-wide: any member of the gap's org.
        (
          g.shared_with_org
          and g.org_id in (
            select org_id from public.org_members where user_id = (select auth.uid())
          )
        )
        -- Master key: super_admin of the gap's org (compliance).
        or public.is_super_admin(g.org_id)
        -- Attendees: participant-seeded (or explicitly added) gap viewers.
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
-- 2. list_assigned_questions() — METADATA-ONLY view for the assignee (R8/AE3)
------------------------------------------------------------
-- Returns the gaps assigned to the CALLER, exposing ONLY the question (the gap's
-- canonical title), who asked it (the latest occurrence's asker_name), and the
-- recurrence metrics — NEVER gap_occurrences.verbatim_question rows or
-- knowledge_gap_sections. SECURITY DEFINER so a non-attendee assignee (who fails
-- can_view_gap) can still read this restricted projection of their assignments.

create or replace function public.list_assigned_questions()
  returns table (
    gap_id text,
    title text,
    asker_name text,
    frequency int,
    last_asked_at timestamptz,
    status text
  )
  language sql
  stable
  security definer
  set search_path = public
as $$
  select
    g.gap_id,
    g.title,
    (
      select o.asker_name
      from public.gap_occurrences o
      where o.gap_id = g.gap_id
      order by o.asked_at desc
      limit 1
    ) as asker_name,
    g.frequency,
    g.last_asked_at,
    g.status
  from public.knowledge_gaps g
  where g.assignee_id = (select auth.uid());
$$;

revoke all on function public.list_assigned_questions() from public;
grant execute on function public.list_assigned_questions() to authenticated;
