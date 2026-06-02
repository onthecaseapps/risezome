-- Per-capture aggregates for the Captures list: answers (done, non-retracted
-- syntheses), sources (live cards), and the distinct in-call speaker names.
--
-- Done as one set-returning function so the list page makes a single round
-- trip instead of pulling every transcript-event payload to the app just to
-- dedupe speaker names (which would be megabytes at 100 meetings). Speaker
-- names live in meeting_events.payload->>'speaker' for type 'transcript.data'.
--
-- security invoker so org-scoped RLS on syntheses / cards / meeting_events
-- still applies to the caller; meeting_id is the leading index column on all
-- three tables, so each subquery is an index scan.

create or replace function public.capture_card_stats(p_meeting_ids uuid[])
returns table (
  meeting_id uuid,
  answers_count integer,
  sources_count integer,
  speakers text[]
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    m.meeting_id,
    coalesce((
      select count(*)
      from public.syntheses s
      where s.meeting_id = m.meeting_id
        and s.status = 'done'
        and s.retracted_at is null
    ), 0)::integer as answers_count,
    coalesce((
      select count(*)
      from public.cards c
      where c.meeting_id = m.meeting_id
        and c.retracted_at is null
    ), 0)::integer as sources_count,
    coalesce((
      select array_agg(distinct e.payload->>'speaker' order by e.payload->>'speaker')
      from public.meeting_events e
      where e.meeting_id = m.meeting_id
        and e.type = 'transcript.data'
        and e.payload->>'speaker' is not null
        and e.payload->>'speaker' <> ''
    ), '{}'::text[]) as speakers
  from unnest(p_meeting_ids) as m(meeting_id);
$$;

grant execute on function public.capture_card_stats(uuid[]) to authenticated, service_role;
