-- Privacy-aware RLS rewrite across the capture tables (permissions overhaul U3).
-- Plan: docs/plans/2026-06-04-004-feat-permissions-overhaul-plan.md — U3; KTD3, KTD4.
--
-- This is the CORE security unit. It replaces the participant-scoped SELECT
-- policies created in 20260603330000 with a single privacy-LEVEL-aware predicate,
-- public.can_access_meeting(meeting_id), applied UNIFORMLY across every table
-- that carries a meeting's payload (KTD3). All capture tables move together so a
-- meeting hidden on `meetings` cannot leak through a sibling table's REST
-- endpoint (the explicit reason the original visibility migration covered them as
-- a set).
--
-- ── KTD4 — REVERSAL OF A DOCUMENTED DECISION ─────────────────────────────────
-- The original visibility migration (20260603330000) deliberately made
-- "managers NOT exempt" from participant scoping. can_access_meeting INTENTIONALLY
-- OVERRIDES that — BUT ONLY for the super_admin tier (the audited master key,
-- R3/F6), via `public.is_super_admin(org_id)`. Plain managers are NOT exempt and
-- get NO bypass here; they see a meeting only when its privacy_level grants it
-- (only_teammates) or they participated / own it, exactly like any other member.
-- The super_admin master-key access is AUDITED at the app layer in U5 (an RLS
-- SELECT policy cannot reliably append an audit row — KTD5). RLS grants the row;
-- the app records the trail.
--
-- ── can_access_meeting(p_meeting_id) — the new predicate (KTD3) ───────────────
-- Returns true when, for the meeting's (org_id, user_id=owner, privacy_level):
--   * caller is a super_admin of the meeting's org   (master key, KTD4),       OR
--   * caller is the owner (meetings.user_id = auth.uid()),                      OR
--   * privacy_level = 'only_teammates' AND caller is a member of the org,       OR
--   * privacy_level = 'only_participants' AND is_meeting_participant(meeting),   OR
--   * privacy_level = 'only_me'  -> false (owner/super_admin already covered).
-- A null/absent meeting returns false (no row -> no access).
--
-- SECURITY DEFINER + set search_path = public, mirroring is_meeting_participant /
-- is_org_admin: it reads org_members / meetings OUTSIDE RLS so the policies that
-- call it never re-trigger the org_members self-recursion bug fixed in
-- 20260530110000. auth.uid() still resolves from the request JWT. Org membership
-- is resolved by a direct (recursion-free) org_members lookup, the same shape as
-- is_meeting_participant / is_super_admin use.
--
-- ── SCOPE NOTE — the per-meeting `gaps` table no longer exists ────────────────
-- The plan lists a `gaps` SELECT policy + a gaps confirm/dismiss UPDATE policy to
-- rewrite. Those are STALE: the vestigial per-meeting `public.gaps` table (and
-- therefore all of its policies, incl. those created in 20260603330000) was
-- DROPPED with CASCADE in 20260606020000_knowledge_gaps.sql, replaced by the
-- cross-meeting knowledge_gaps model. There is nothing to rewrite for `gaps`, and
-- there is no gaps confirm/dismiss UPDATE to align. The live capture tables that
-- still carry per-meeting payload and still use is_meeting_participant are:
-- meetings, cards, syntheses, meeting_events, and realtime.messages — those five
-- are rewritten below.
--
-- ── can_view_gap DECISION — LEFT AS-IS (knowledge_gaps is org-level) ──────────
-- knowledge_gaps is an ORG-LEVEL aggregate (PK gap_id, columns org_id +
-- shared_with_org/assignee/section, and NO meeting_id). A single gap is assembled
-- from gap_occurrences spanning MULTIPLE meetings (the cross-meeting model), so it
-- is not the property of any one meeting and cannot inherit a single meeting's
-- privacy_level. Its visibility is governed by its OWN ACL (shared_with_org +
-- org-member, assignee, is_org_admin, or gap_viewers — seeded from the
-- participants of the meetings it came from). Because gap_viewers is participant-
-- seeded, the verbatim text a gap exposes is already only visible to people who
-- were in one of the contributing meetings (or to whom it was shared/assigned/
-- admin), independent of those meetings' later privacy_level changes. Gating
-- can_view_gap on can_access_meeting would be ill-defined (which of N meetings?)
-- and would not match the org-level aggregate's intended sharing model. Decision:
-- can_view_gap stays unchanged; gaps are independent of per-meeting privacy.

------------------------------------------------------------
-- 1. can_access_meeting(p_meeting_id) — privacy-aware access predicate
------------------------------------------------------------

create or replace function public.can_access_meeting(p_meeting_id uuid)
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
        -- Master key: super_admin of the meeting's org (audited at app layer, KTD4).
        public.is_super_admin(m.org_id)
        -- Owner always sees their own meeting (covers only_me).
        or m.user_id = (select auth.uid())
        -- only_teammates: any member of the meeting's org.
        or (
          m.privacy_level = 'only_teammates'
          and exists (
            select 1 from public.org_members om
            where om.org_id = m.org_id
              and om.user_id = (select auth.uid())
          )
        )
        -- only_participants: people who attended the meeting.
        or (
          m.privacy_level = 'only_participants'
          and public.is_meeting_participant(m.meeting_id)
        )
        -- only_me: only owner/super_admin (handled above) -> false otherwise.
      )
  );
$$;

revoke all on function public.can_access_meeting(uuid) from public;
grant execute on function public.can_access_meeting(uuid) to authenticated;

------------------------------------------------------------
-- 2. Rewrite the per-meeting SELECT policies onto can_access_meeting
--    (meetings, cards, syntheses, meeting_events). Each currently uses
--    is_meeting_participant(meeting_id) (20260603330000).
------------------------------------------------------------

drop policy if exists "participants read their meetings" on public.meetings;
create policy "members access their meetings by privacy"
  on public.meetings for select
  to authenticated
  using (public.can_access_meeting(meeting_id));

drop policy if exists "participants read meeting cards" on public.cards;
create policy "members access meeting cards by privacy"
  on public.cards for select
  to authenticated
  using (public.can_access_meeting(meeting_id));

drop policy if exists "participants read meeting syntheses" on public.syntheses;
create policy "members access meeting syntheses by privacy"
  on public.syntheses for select
  to authenticated
  using (public.can_access_meeting(meeting_id));

drop policy if exists "participants read meeting events" on public.meeting_events;
create policy "members access meeting events by privacy"
  on public.meeting_events for select
  to authenticated
  using (public.can_access_meeting(meeting_id));

------------------------------------------------------------
-- 3. realtime.messages broadcast policy — same meetingId extraction
--    (split_part(topic, ':', 3)), now wrapped in can_access_meeting.
------------------------------------------------------------

drop policy if exists "participants read their meeting broadcasts" on realtime.messages;
create policy "members access their meeting broadcasts by privacy"
  on realtime.messages for select
  to authenticated
  using (
    extension = 'broadcast'
    and topic like 'meeting:%'
    and public.can_access_meeting(split_part(topic, ':', 3)::uuid)
  );
