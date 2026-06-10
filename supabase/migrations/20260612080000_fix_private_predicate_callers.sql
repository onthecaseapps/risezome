-- Follow-up to 20260612070000 (private authz schema): two function BODIES
-- outside the moved set referenced the relocated predicates by their old
-- `public.` names. SQL/plpgsql bodies resolve names at execution time, so
-- both broke at runtime after the move ("function public.can_view_gap_content
-- (text) does not exist" on the Gaps page). Re-create them with `private.`
-- qualification; bodies otherwise verbatim from 20260612010000 /
-- 20260608040000.

create or replace function public.knowledge_gaps_stats(p_gap_ids text[])
returns table (
  gap_id    text,
  people    integer,
  meetings  integer,
  moments   integer,
  phrasings integer,
  can_view_content boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with agg as (
    select
      o.gap_id,
      count(distinct o.asker_name)::integer        as people,
      count(distinct o.meeting_id)::integer        as meetings,
      count(*)::integer                            as moments,
      count(distinct o.verbatim_question)::integer as phrasings
    from public.gap_occurrences o
    where o.gap_id = any(p_gap_ids)
    group by o.gap_id
  )
  select
    g.gap_id,
    coalesce(a.people, 0),
    coalesce(a.meetings, 0),
    coalesce(a.moments, 0),
    coalesce(a.phrasings, 0),
    private.can_view_gap_content(g.gap_id) as can_view_content
  from unnest(p_gap_ids) as g(gap_id)
  left join agg a on a.gap_id = g.gap_id;
$$;

create or replace function public.admin_override_meeting_privacy(
  p_meeting_id uuid,
  p_level text
)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_org_id uuid;
begin
  if p_level not in ('only_me', 'only_participants', 'only_teammates') then
    raise exception 'invalid privacy level %', p_level
      using errcode = 'check_violation';
  end if;

  -- Resolve the meeting's org (also tells us the meeting exists).
  select org_id into v_org_id
  from public.meetings
  where meeting_id = p_meeting_id;

  if v_org_id is null then
    raise exception 'meeting % not found', p_meeting_id
      using errcode = 'no_data_found';
  end if;

  -- SELF-CHECK: only an admin (manager OR super_admin) of THIS meeting's org may
  -- override. is_org_admin resolves auth.uid() from the request JWT.
  if not private.is_org_admin(v_org_id) then
    raise exception 'not authorized to override meeting privacy'
      using errcode = 'insufficient_privilege';
  end if;

  -- Floor-exempt write (KTD7/R12): the transaction-local GUC tells the floor
  -- trigger to allow a below-floor level. `set local` confines it to this tx.
  perform set_config('app.bypass_privacy_floor', 'on', true);

  update public.meetings
  set privacy_level = p_level
  where meeting_id = p_meeting_id
    and org_id = v_org_id;
end;
$$;
