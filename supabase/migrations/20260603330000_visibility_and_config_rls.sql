-- Per-person visibility + manager-only config writes (plan U4).
-- (Plan: docs/plans/2026-06-01-001-feat-workspace-invitations-roles-plan.md)
--
-- This migration NARROWS several existing SELECT policies from org-wide to
-- per-person/participant scope, and gates config writes on the manager role.
-- Narrowing hides rows users can currently see, so it is a deliberate
-- (tested) visibility regression. Every captures-bearing table is covered —
-- meetings, cards, syntheses, gaps, meeting_events — because narrowing only
-- `meetings` would leave the others readable org-wide via the REST API.
--
-- Helpers (from U1/U3, SECURITY DEFINER, recursion-safe):
--   is_org_manager(org_id)         — caller is a manager of org
--   is_meeting_participant(mtg_id)  — caller attended the meeting

------------------------------------------------------------
-- org_members: own row always; all org rows for a manager (R6)
------------------------------------------------------------

drop policy if exists "user reads their own org_member rows" on public.org_members;

create policy "read own membership or all as manager"
  on public.org_members for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_org_manager(org_id)
  );

------------------------------------------------------------
-- meetings + captures: participant-scoped (managers NOT exempt — R5/R14)
------------------------------------------------------------

drop policy if exists "members read their org's meetings" on public.meetings;
create policy "participants read their meetings"
  on public.meetings for select
  to authenticated
  using (public.is_meeting_participant(meeting_id));

drop policy if exists "members read their org's cards" on public.cards;
create policy "participants read meeting cards"
  on public.cards for select
  to authenticated
  using (public.is_meeting_participant(meeting_id));

drop policy if exists "members pin cards in their org" on public.cards;
create policy "participants pin meeting cards"
  on public.cards for update
  to authenticated
  using (public.is_meeting_participant(meeting_id))
  with check (public.is_meeting_participant(meeting_id));

drop policy if exists "members read their org's syntheses" on public.syntheses;
create policy "participants read meeting syntheses"
  on public.syntheses for select
  to authenticated
  using (public.is_meeting_participant(meeting_id));

drop policy if exists "members read their org's gaps" on public.gaps;
create policy "participants read meeting gaps"
  on public.gaps for select
  to authenticated
  using (public.is_meeting_participant(meeting_id));

drop policy if exists "members confirm/dismiss gaps in their org" on public.gaps;
create policy "participants confirm/dismiss meeting gaps"
  on public.gaps for update
  to authenticated
  using (public.is_meeting_participant(meeting_id))
  with check (public.is_meeting_participant(meeting_id));

drop policy if exists "members read their org's meeting events" on public.meeting_events;
create policy "participants read meeting events"
  on public.meeting_events for select
  to authenticated
  using (public.is_meeting_participant(meeting_id));

------------------------------------------------------------
-- calendar_events: owner-scoped (your own calendar only)
------------------------------------------------------------

drop policy if exists "members read their org's calendar events" on public.calendar_events;
create policy "users read their own calendar events"
  on public.calendar_events for select
  to authenticated
  using (user_id = (select auth.uid()));

------------------------------------------------------------
-- realtime.messages: participant-scoped on the meetingId (3rd topic segment)
------------------------------------------------------------

drop policy if exists "members read their org's meeting broadcasts" on realtime.messages;
create policy "participants read their meeting broadcasts"
  on realtime.messages for select
  to authenticated
  using (
    extension = 'broadcast'
    and topic like 'meeting:%'
    and public.is_meeting_participant(split_part(topic, ':', 3)::uuid)
  );

------------------------------------------------------------
-- Config writes: managers only (R3)
------------------------------------------------------------

drop policy if exists "members upsert their workspace bot settings (insert)" on public.workspace_bot_settings;
create policy "managers upsert workspace bot settings (insert)"
  on public.workspace_bot_settings for insert
  to authenticated
  with check (public.is_org_manager(org_id));

drop policy if exists "members upsert their workspace bot settings (update)" on public.workspace_bot_settings;
create policy "managers upsert workspace bot settings (update)"
  on public.workspace_bot_settings for update
  to authenticated
  using (public.is_org_manager(org_id))
  with check (public.is_org_manager(org_id));

-- sources are a manager-only surface (members are gated out of /sources);
-- the app redirect is not authorization, so narrow the data read too.
drop policy if exists "members read their org's sources" on public.sources;
create policy "managers read their org's sources"
  on public.sources for select
  to authenticated
  using (public.is_org_manager(org_id));
