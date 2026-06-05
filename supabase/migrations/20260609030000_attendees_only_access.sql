-- Collapse meeting access to ATTENDEES-ONLY; retire the privacy ladder (U2).
-- Plan: docs/plans/2026-06-04-006-feat-teams-restructure-plan.md — U2; KTD1, KTD2.
--
-- The teams restructure replaces the 3-level per-meeting privacy ladder (shipped
-- in plan 2026-06-04-004, deployed) with the simplest correct rule: a meeting and
-- all its sibling payload tables are visible to its ATTENDEES plus the audited
-- super-admin master key. "The people in the room see it."
--
-- ── KTD1 — the function changes, the policies don't ──────────────────────────
-- The five capture-table SELECT policies (meetings, cards, syntheses,
-- meeting_events, realtime.messages) created in 20260608030000 already delegate
-- to public.can_access_meeting(meeting_id). We rewrite ONLY the function body, so
-- the single-predicate sibling-leak guarantee holds for free and there is zero
-- policy churn. The master-key bypass (is_super_admin) stays and is still audited
-- at the app layer (app/_lib/meeting-access.ts) — RLS grants the row; the app
-- records the trail.
--
-- ── KTD2 — drop the privacy machinery in dependency order ─────────────────────
-- 1) rewrite can_access_meeting so it no longer references privacy_level
-- 2) drop the floor trigger + function (reference privacy_level / rank)
-- 3) drop admin_override_meeting_privacy (writes privacy_level)
-- 4) drop meetings.privacy_level
-- 5) drop org_privacy_config (its CHECK depends on meeting_privacy_rank)
-- 6) drop meeting_privacy_rank last (now unreferenced)

------------------------------------------------------------
-- 1. can_access_meeting -> attendees ∪ super-admin (KTD1)
------------------------------------------------------------
-- Owner is kept as an explicit belt-and-suspenders branch: the owner is normally
-- a participant (meeting_participants is seeded with the owner at launch), but a
-- defensive owner check guarantees the creator never loses access if a
-- participant row is ever missing.

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
        -- Master key: super_admin of the meeting's org (audited at app layer, KTD1).
        public.is_super_admin(m.org_id)
        -- Owner always sees their own meeting (belt-and-suspenders).
        or m.user_id = (select auth.uid())
        -- Attendees: the people who were in the room.
        or public.is_meeting_participant(m.meeting_id)
      )
  );
$$;

revoke all on function public.can_access_meeting(uuid) from public;
grant execute on function public.can_access_meeting(uuid) to authenticated;

------------------------------------------------------------
-- 2. Drop the floor-enforcement trigger + function (KTD2)
------------------------------------------------------------
drop trigger if exists meetings_enforce_privacy_floor on public.meetings;
drop function if exists public.enforce_meeting_privacy_floor();

------------------------------------------------------------
-- 3. Drop the admin-override RPC (wrote privacy_level)
------------------------------------------------------------
drop function if exists public.admin_override_meeting_privacy(uuid, text);

------------------------------------------------------------
-- 4. Drop meetings.privacy_level
------------------------------------------------------------
alter table public.meetings drop column if exists privacy_level;

------------------------------------------------------------
-- 5. Drop org_privacy_config (default/floor are gone; access is attendees-only)
------------------------------------------------------------
drop table if exists public.org_privacy_config;

------------------------------------------------------------
-- 6. Drop the now-unreferenced privacy-rank helper
------------------------------------------------------------
drop function if exists public.meeting_privacy_rank(text);
