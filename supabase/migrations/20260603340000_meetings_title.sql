-- Denormalize a meeting title onto meetings (plan U6 / KTD3 title resolution).
-- (Plan: docs/plans/2026-06-01-001-feat-workspace-invitations-roles-plan.md)
--
-- Meeting titles were read by joining meetings.calendar_event_id ->
-- calendar_events, but that event belongs to the LAUNCHER. After U4 narrowed
-- calendar_events to the owner, a non-launcher participant (the central
-- R8/AE7 case) can read the meeting but not the launcher's event, so the
-- title silently degraded to a fallback. Store the title on the meeting at
-- launch time instead; readers prefer meetings.title.

alter table public.meetings add column title text not null default '';

-- Backfill from the launching event where available.
update public.meetings m
set title = ce.title
from public.calendar_events ce
where ce.id = m.calendar_event_id
  and coalesce(ce.title, '') <> '';
