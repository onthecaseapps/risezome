-- One bot per meeting: conference-URL dedup + multi-user participant set.
-- (Plan U3: docs/plans/2026-06-01-001-feat-workspace-invitations-roles-plan.md)
--
-- Today `meetings` dedups per calendar_event_id, but each attendee has their
-- OWN calendar_events row for the same call — so two workspace users on one
-- meeting would each launch a bot. This migration moves dedup to the actual
-- meeting (its conference URL) and associates multiple users with the single
-- instance.
--
-- EXPAND PHASE — strictly additive. `launch-bot.ts` still writes
-- { user_id, calendar_event_id } and relies on the old per-event index until
-- U6 ships the find-or-create launch path. We therefore KEEP meetings.user_id
-- (now meaning "the launcher") and the old index in place, and only ADD the
-- conference_url column, the new live-dedup index, and meeting_participants.
-- A follow-up (contract phase, after U6) drops the legacy per-event index.

------------------------------------------------------------
-- conference_url on meetings (was only on calendar_events)
------------------------------------------------------------

alter table public.meetings add column conference_url text;

-- Backfill from the launching event. Rows whose event was deleted
-- (calendar_event_id null via ON DELETE SET NULL) or had no URL stay null
-- and are excluded from the dedup index below.
update public.meetings m
set conference_url = ce.conference_url
from public.calendar_events ce
where ce.id = m.calendar_event_id
  and ce.conference_url is not null;

create index meetings_conference_url_idx on public.meetings (conference_url);

-- Dedup backstop: at most one LIVE bot per (org, conference URL). Scoped to
-- in-flight/active statuses only — NOT 'completed' — so a finished meeting on
-- a reused recurring/personal-room link does not block the next instance
-- (KTD8 over-merge hazard), while two concurrent launches still collapse to
-- one. The find-or-create launch path (U6) does the time-scoped lookup; this
-- index is the hard race backstop.
create unique index meetings_live_per_conference_url_idx
  on public.meetings (org_id, conference_url)
  where status in ('launching', 'awaiting_recall', 'joining', 'waiting_room', 'recording')
    and conference_url is not null;

------------------------------------------------------------
-- meeting_participants: the users associated with one meeting
------------------------------------------------------------

create table public.meeting_participants (
  meeting_id  uuid        not null references public.meetings(meeting_id) on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (meeting_id, user_id)
);

create index meeting_participants_user_id_idx on public.meeting_participants (user_id);

-- Backfill: every existing meeting's launcher becomes its sole participant.
insert into public.meeting_participants (meeting_id, user_id)
select meeting_id, user_id from public.meetings
on conflict do nothing;

alter table public.meeting_participants enable row level security;

-- A user reads only their own participant rows. The "is X a participant of
-- meeting Y" predicate used by other tables' policies goes through the
-- SECURITY DEFINER helper below, not this policy.
create policy "users read their own participant rows"
  on public.meeting_participants for select
  to authenticated
  using (user_id = (select auth.uid()));
-- No user-facing write policies: associations are written by the service-role
-- launch path (U6) only.

------------------------------------------------------------
-- Participation predicate (SECURITY DEFINER — used by U4 visibility policies)
------------------------------------------------------------

-- True when the calling user is a participant of p_meeting_id. SECURITY
-- DEFINER so meetings/cards/realtime policies can call it without joining
-- meeting_participants under RLS.
create function public.is_meeting_participant(p_meeting_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.meeting_participants
    where meeting_id = p_meeting_id
      and user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_meeting_participant(uuid) from public;
grant execute on function public.is_meeting_participant(uuid) to authenticated;
