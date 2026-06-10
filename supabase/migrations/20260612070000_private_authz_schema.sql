-- Move the pure-RLS authorization predicates out of the PostgREST-exposed
-- `public` schema (Security Advisor: authenticated_security_definer_
-- function_executable).
--
-- These nine SECURITY DEFINER helpers exist ONLY to be evaluated inside RLS
-- policies. Policies run as the querying role, so `authenticated` must keep
-- EXECUTE — the lint can't be satisfied by revoking. What CAN go away is the
-- API surface: PostgREST exposes only `public`, so relocating the functions
-- to a `private` schema removes their /rest/v1/rpc/ endpoints entirely while
-- every existing policy keeps working (policies bind functions by OID, and
-- ALTER FUNCTION ... SET SCHEMA preserves the OID).
--
-- All nine are self-guarded (booleans about the caller; org_member_ids
-- returns rows only for the caller's own org), so this is defense-in-depth
-- plus advisor hygiene, not a leak fix.
--
-- NOT moved: list_assigned_questions (the portal client calls it via RPC —
-- its lint finding is intentional; the function is scoped to auth.uid()) and
-- meeting_effective_source_ids (bot-worker RPC; authenticated already
-- revoked).
--
-- ⚠ Future-migration discipline: new policies or function bodies must
-- reference these as `private.is_org_admin(...)` etc. Unqualified or
-- `public.`-qualified references will fail to resolve.

create schema if not exists private;
-- Executing a function requires USAGE on its schema for the calling role.
-- Policies evaluate as authenticated; Inngest/bot-worker paths as service_role.
grant usage on schema private to authenticated, service_role;

------------------------------------------------------------
-- 1. Relocate (OID-preserving; all policies keep working untouched).
------------------------------------------------------------
alter function public.is_org_admin(uuid) set schema private;
alter function public.is_org_manager(uuid) set schema private;
alter function public.is_super_admin(uuid) set schema private;
alter function public.is_team_member(uuid) set schema private;
alter function public.is_meeting_participant(uuid) set schema private;
alter function public.org_member_ids(uuid) set schema private;
alter function public.can_access_meeting(uuid) set schema private;
alter function public.can_view_gap(text) set schema private;
alter function public.can_view_gap_content(text) set schema private;

------------------------------------------------------------
-- 2. The three composite predicates referenced their helpers with explicit
--    `public.` qualification, which is now dangling — SQL-function bodies
--    resolve names at execution time, not creation time. Re-create them
--    (same OID via create-or-replace) with `private.` qualification.
--    Bodies are otherwise verbatim from 20260609030000 / 20260611010000.
------------------------------------------------------------
create or replace function private.can_access_meeting(p_meeting_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
    from public.meetings m
    where m.meeting_id = p_meeting_id
      and (
        -- Master key: super_admin of the meeting's org (audited at app layer, KTD1).
        private.is_super_admin(m.org_id)
        -- Owner always sees their own meeting (belt-and-suspenders).
        or m.user_id = (select auth.uid())
        -- Attendees: the people who were in the room.
        or private.is_meeting_participant(m.meeting_id)
      )
  );
$$;

create or replace function private.can_view_gap(p_gap_id text)
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
        -- Shared org-wide: any member of the gap's org (ROW only; content is
        -- gated separately by can_view_gap_content).
        (
          g.shared_with_org
          and g.org_id in (
            select org_id from public.org_members where user_id = (select auth.uid())
          )
        )
        -- Master key: super_admin of the gap's org.
        or private.is_super_admin(g.org_id)
        -- Attendees: participant-seeded (or explicitly added) gap viewers.
        or exists (
          select 1 from public.gap_viewers v
          where v.gap_id = g.gap_id and v.user_id = (select auth.uid())
        )
        -- Assignment grants ROW visibility (title/status) so the assignee can see
        -- and resolve the question. Verbatim stays gated by can_view_gap_content.
        or g.assignee_id = (select auth.uid())
      )
  );
$$;

create or replace function private.can_view_gap_content(p_gap_id text)
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
        -- Master key: super_admin of the gap's org (compliance, unaudited at the
        -- RLS layer like the meeting master key).
        private.is_super_admin(g.org_id)
        -- Attendees only: was in (or explicitly added to) the source meeting(s).
        or exists (
          select 1 from public.gap_viewers v
          where v.gap_id = g.gap_id and v.user_id = (select auth.uid())
        )
      )
  );
$$;
