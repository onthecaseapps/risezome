-- Corrective: 20260603330000 tried to drop the old org-wide calendar_events
-- SELECT policy by the wrong name ("members read their org's events"), so the
-- real policy ("members read their org's calendar events") survived alongside
-- the new owner-scoped one. Permissive SELECT policies OR together, so calendar
-- events stayed org-wide visible — defeating the per-person narrowing (R5).
-- Drop the correctly-named old policy. Idempotent.

drop policy if exists "members read their org's calendar events" on public.calendar_events;
