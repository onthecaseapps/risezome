-- team_sources.enabled: non-destructive ENABLE/DISABLE (pause) per team-source.
--
-- The top-level source toggle on the Sources page flips this flag. A disabled
-- (paused) source KEEPS its corpus and its team_sources row — so the purge
-- reference count is unchanged and nothing de-indexes — but it is EXCLUDED from
-- meeting retrieval. This is deliberately distinct from REMOVAL: removing a
-- source deletes the team_sources row (refcount -> 0 => the purge cron
-- de-indexes). Pause is instant and reversible with no re-index.
--
-- Default TRUE so every existing selection stays active on cutover.

alter table public.team_sources
  add column if not exists enabled boolean not null default true;

-- Retrieval must skip paused sources. Re-create meeting_effective_source_ids
-- (shipped in 20260609060000) with an `and ts.enabled` filter on the
-- team_sources join. SECURITY DEFINER + search_path are preserved; the hardened
-- grants (revoked from public/anon/authenticated — service-role only, set in
-- 20260612020000 / 20260612060000) persist across create-or-replace, and are
-- re-asserted below for clarity.
create or replace function public.meeting_effective_source_ids(p_meeting_id uuid)
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select distinct ts.source_id
  from public.meetings m
  join public.meeting_participants mp on mp.meeting_id = m.meeting_id
  join public.org_members om on om.org_id = m.org_id and om.user_id = mp.user_id
  join public.team_members tm on tm.user_id = mp.user_id
  join public.teams t on t.team_id = tm.team_id and t.org_id = m.org_id and t.archived_at is null
  join public.team_sources ts on ts.team_id = t.team_id and ts.enabled
  where m.meeting_id = p_meeting_id;
$$;

revoke execute on function public.meeting_effective_source_ids(uuid) from public, anon, authenticated;
