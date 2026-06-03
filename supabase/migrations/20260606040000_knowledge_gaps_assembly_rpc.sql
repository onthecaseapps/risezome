------------------------------------------------------------
-- Knowledge Gaps — assembly RPC (plan U6 / U7)
--   docs/plans/2026-06-02-002-feat-knowledge-gaps-plan.md
--
-- The post-meeting Inngest job embeds and dedups a meeting's misses in JS, then
-- calls this function ONCE PER dedup group. Each call runs in its own
-- transaction holding an org-scoped advisory lock (KTD4), so two meetings for
-- the same org that end simultaneously can't both create a gap for the same
-- question — the second call sees the first's committed gap and merges.
--
-- Idempotency (KTD4): occurrences carry a unique (meeting_id, utterance_id);
-- inserts are ON CONFLICT DO NOTHING. A retried assembly re-inserts nothing,
-- so frequency never double-counts and a closed gap is not spuriously
-- resurfaced (resurface only fires when a NEW occurrence actually landed).
--
-- Service-role only (SECURITY DEFINER); the function is not granted to
-- authenticated clients.
------------------------------------------------------------

create function public.assemble_gap_occurrence_group(
  p_org_id      uuid,
  p_meeting_id  uuid,
  p_centroid    text,          -- vector literal '[...]' (1024 dims)
  p_title       text,
  p_merge_max   double precision,
  p_occurrences jsonb,         -- [{utterance_id, verbatim_question, asker_name, reason, asked_at}]
  p_viewer_ids  uuid[]         -- meeting participants to grant visibility
)
  returns table (gap_id text, created boolean, resurfaced boolean, assignee_id uuid)
  language plpgsql
  security definer
  set search_path = public
as $$
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
  -- Serialize all assembly within this org (KTD4). Transaction-scoped: released
  -- automatically on commit/rollback.
  perform pg_advisory_xact_lock(hashtext(p_org_id::text));

  -- Nearest existing gap within the merge threshold (cosine distance via <=>).
  select g.gap_id, g.status, g.assignee_id
    into v_gap_id, v_status, v_assignee
  from public.knowledge_gaps g
  where g.org_id = p_org_id
    and g.embedding is not null
    and (g.embedding <=> v_centroid) <= p_merge_max
  order by g.embedding <=> v_centroid
  limit 1;

  if v_gap_id is null then
    -- Create a new gap seeded with this group's centroid + first phrasing.
    v_gap_id := 'gap_' || replace(gen_random_uuid()::text, '-', '');
    v_created := true;
    insert into public.knowledge_gaps (gap_id, org_id, title, embedding, status, frequency,
                                       first_asked_at, last_asked_at)
    values (v_gap_id, p_org_id, p_title, v_centroid, 'open', 0, now(), now());
  end if;

  -- Append occurrences (idempotent on (meeting_id, utterance_id)).
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

  -- Nothing new landed (pure retry) → leave the gap untouched.
  if v_inserted = 0 and not v_created then
    return query select v_gap_id, false, false, v_assignee;
    return;
  end if;

  -- Grant visibility to this meeting's participants (union on merge).
  if p_viewer_ids is not null then
    foreach v_uid in array p_viewer_ids loop
      insert into public.gap_viewers (gap_id, user_id, org_id)
      values (v_gap_id, v_uid, p_org_id)
      on conflict (gap_id, user_id) do nothing;
    end loop;
  end if;

  -- Resurface a closed gap that was just asked again (R16 / AE4).
  if not v_created and v_status in ('resolved', 'dismissed') then
    v_resurfaced := true;
  end if;

  update public.knowledge_gaps
  set frequency = (select count(*) from public.gap_occurrences where gap_occurrences.gap_id = v_gap_id),
      last_asked_at = now(),
      status = case when v_resurfaced then 'open' else status end,
      reopened_after_close = case when v_resurfaced then true else reopened_after_close end,
      reopened_at = case when v_resurfaced then now() else reopened_at end,
      -- Clear the prior closure record when reopening, so the gap doesn't carry
      -- a stale resolved/dismissed-by stamp.
      resolved_by = case when v_resurfaced then null else resolved_by end,
      resolved_at = case when v_resurfaced then null else resolved_at end,
      dismissed_by = case when v_resurfaced then null else dismissed_by end,
      dismissed_at = case when v_resurfaced then null else dismissed_at end
  where knowledge_gaps.gap_id = v_gap_id;

  return query select v_gap_id, v_created, v_resurfaced, v_assignee;
end;
$$;

revoke all on function public.assemble_gap_occurrence_group(uuid, uuid, text, text, double precision, jsonb, uuid[]) from public;
-- service role bypasses grants, but be explicit that authenticated cannot call it.
