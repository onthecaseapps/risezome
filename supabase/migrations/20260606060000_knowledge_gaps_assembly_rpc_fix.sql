------------------------------------------------------------
-- Knowledge Gaps — assembly RPC fix (plan U6 follow-up)
--   docs/plans/2026-06-02-002-feat-knowledge-gaps-plan.md
--
-- The RETURNS TABLE (gap_id ..., assignee_id ...) columns become implicit
-- PL/pgSQL variables that collide with the same-named table columns, so
-- `on conflict (gap_id, user_id)` raised: column reference "gap_id" is
-- ambiguous. The function never reads those OUT names as variables (it returns
-- positionally via `return query select v_*`), so `#variable_conflict
-- use_column` safely resolves every ambiguous bareword to the column.
--
-- create or replace — the function was already applied by 20260606040000.
------------------------------------------------------------

create or replace function public.assemble_gap_occurrence_group(
  p_org_id      uuid,
  p_meeting_id  uuid,
  p_centroid    text,
  p_title       text,
  p_merge_max   double precision,
  p_occurrences jsonb,
  p_viewer_ids  uuid[]
)
  returns table (gap_id text, created boolean, resurfaced boolean, assignee_id uuid)
  language plpgsql
  security definer
  set search_path = public
as $$
#variable_conflict use_column
declare
  v_gap_id      text;
  v_status      text;
  v_assignee    uuid;
  v_inserted    integer;
  v_created     boolean := false;
  v_resurfaced  boolean := false;
  v_centroid    vector(1024) := p_centroid::vector;
  v_uid         uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_org_id::text));

  select g.gap_id, g.status, g.assignee_id
    into v_gap_id, v_status, v_assignee
  from public.knowledge_gaps g
  where g.org_id = p_org_id
    and g.embedding is not null
    and (g.embedding <=> v_centroid) <= p_merge_max
  order by g.embedding <=> v_centroid
  limit 1;

  if v_gap_id is null then
    v_gap_id := 'gap_' || replace(gen_random_uuid()::text, '-', '');
    v_created := true;
    insert into public.knowledge_gaps (gap_id, org_id, title, embedding, status, frequency,
                                       first_asked_at, last_asked_at)
    values (v_gap_id, p_org_id, p_title, v_centroid, 'open', 0, now(), now());
  end if;

  insert into public.gap_occurrences (gap_id, org_id, meeting_id, utterance_id,
                                      verbatim_question, asker_name, reason, asked_at)
  select v_gap_id, p_org_id, p_meeting_id,
         o->>'utterance_id',
         o->>'verbatim_question',
         coalesce(nullif(o->>'asker_name', ''), 'Unknown'),
         o->>'reason',
         coalesce((o->>'asked_at')::timestamptz, now())
  from jsonb_array_elements(p_occurrences) as o
  on conflict (meeting_id, utterance_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 and not v_created then
    return query select v_gap_id, false, false, v_assignee;
    return;
  end if;

  if p_viewer_ids is not null then
    foreach v_uid in array p_viewer_ids loop
      insert into public.gap_viewers (gap_id, user_id, org_id)
      values (v_gap_id, v_uid, p_org_id)
      on conflict (gap_id, user_id) do nothing;
    end loop;
  end if;

  if not v_created and v_status in ('resolved', 'dismissed') then
    v_resurfaced := true;
  end if;

  update public.knowledge_gaps
  set frequency = (select count(*) from public.gap_occurrences where gap_occurrences.gap_id = v_gap_id),
      last_asked_at = now(),
      status = case when v_resurfaced then 'open' else status end,
      reopened_after_close = case when v_resurfaced then true else reopened_after_close end,
      reopened_at = case when v_resurfaced then now() else reopened_at end,
      resolved_by = case when v_resurfaced then null else resolved_by end,
      resolved_at = case when v_resurfaced then null else resolved_at end,
      dismissed_by = case when v_resurfaced then null else dismissed_by end,
      dismissed_at = case when v_resurfaced then null else dismissed_at end
  where knowledge_gaps.gap_id = v_gap_id;

  return query select v_gap_id, v_created, v_resurfaced, v_assignee;
end;
$$;
