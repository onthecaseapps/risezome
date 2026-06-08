-- Knowledge-gap CONTENT gate — split gap visibility into two tiers so an
-- assignee (or org-wide share) sees the QUESTION but never the room's verbatim.
--
--   ROW    (title / status / section / row-level metrics): a participant
--           (gap_viewers, seeded from meeting_participants) OR shared-with-org
--           OR the super-admin master key OR the ASSIGNEE.
--   CONTENT (gap_occurrences = verbatim paraphrases + the meeting/utterance
--           "open moment" deep-link, and gap_viewers = who attended): a
--           participant OR the super-admin master key ONLY — deliberately NOT
--           shared-with-org and NOT the assignee.
--
-- Why: an assignee who was NOT in the source meeting should be able to SEE and
-- RESOLVE the assigned question (title/status), but must never read the verbatim
-- paraphrases or open the captured moment — they weren't in the room. Sharing a
-- gap org-wide likewise exposes the QUESTION to the org, not the room's verbatim.
-- (Reverses the U5 decision to drop the assignee branch entirely: assignment now
-- grants ROW visibility, while the new content predicate keeps verbatim
-- participant-only. resolveGapAction already permits the assignee to resolve.)

------------------------------------------------------------
-- 1. can_view_gap (ROW) — re-add the assignee branch.
------------------------------------------------------------
create or replace function public.can_view_gap(p_gap_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
    from public.knowledge_gaps g
    where g.gap_id = p_gap_id
      and (
        -- Shared org-wide: any member of the gap's org (ROW only; content is
        -- gated separately by can_view_gap_content).
        (
          g.shared_with_org
          and g.org_id in (
            select org_id from public.org_members where user_id = (select auth.uid())
          )
        )
        -- Master key: super_admin of the gap's org.
        or public.is_super_admin(g.org_id)
        -- Attendees: participant-seeded (or explicitly added) gap viewers.
        or exists (
          select 1 from public.gap_viewers v
          where v.gap_id = g.gap_id and v.user_id = (select auth.uid())
        )
        -- Assignment grants ROW visibility (title/status) so the assignee can see
        -- and resolve the question. Verbatim stays gated by can_view_gap_content.
        or g.assignee_id = (select auth.uid())
      )
  );
$$;

revoke all on function public.can_view_gap(text) from public;
grant execute on function public.can_view_gap(text) to authenticated;

------------------------------------------------------------
-- 2. can_view_gap_content (CONTENT) — participant ∪ super-admin master key.
--    Deliberately excludes shared_with_org and the assignee branch.
------------------------------------------------------------
create or replace function public.can_view_gap_content(p_gap_id text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
    from public.knowledge_gaps g
    where g.gap_id = p_gap_id
      and (
        -- Master key: super_admin of the gap's org (compliance, unaudited at the
        -- RLS layer like the meeting master key).
        public.is_super_admin(g.org_id)
        -- Attendees only: was in (or explicitly added to) the source meeting(s).
        or exists (
          select 1 from public.gap_viewers v
          where v.gap_id = g.gap_id and v.user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function public.can_view_gap_content(text) from public;
grant execute on function public.can_view_gap_content(text) to authenticated;

------------------------------------------------------------
-- 3. Tighten the CONTENT tables to the content predicate. The gap ROW
--    (knowledge_gaps) keeps can_view_gap; only verbatim/attendee tables tighten.
------------------------------------------------------------
drop policy if exists "view occurrences of visible gaps" on public.gap_occurrences;
create policy "view occurrences of content-visible gaps"
  on public.gap_occurrences for select
  to authenticated
  using (public.can_view_gap_content(gap_id));

drop policy if exists "view viewers of visible gaps" on public.gap_viewers;
create policy "view viewers of content-visible gaps"
  on public.gap_viewers for select
  to authenticated
  using (public.can_view_gap_content(gap_id));

------------------------------------------------------------
-- 4. Surface can_view_content on the stats RPC so the UI can render the gap ROW
--    (title/status) while hiding paraphrases + moments for non-content viewers.
--    The occurrence aggregates already read 0 for them (security invoker honours
--    the tightened gap_occurrences RLS). Return type changed → drop + recreate.
------------------------------------------------------------
drop function if exists public.knowledge_gaps_stats(text[]);
create function public.knowledge_gaps_stats(p_gap_ids text[])
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
  select
    g.gap_id,
    coalesce((
      select count(distinct o.asker_name) from public.gap_occurrences o where o.gap_id = g.gap_id
    ), 0)::integer as people,
    coalesce((
      select count(distinct o.meeting_id) from public.gap_occurrences o where o.gap_id = g.gap_id
    ), 0)::integer as meetings,
    coalesce((
      select count(*) from public.gap_occurrences o where o.gap_id = g.gap_id
    ), 0)::integer as moments,
    coalesce((
      select count(distinct o.verbatim_question) from public.gap_occurrences o where o.gap_id = g.gap_id
    ), 0)::integer as phrasings,
    public.can_view_gap_content(g.gap_id) as can_view_content
  from unnest(p_gap_ids) as g(gap_id);
$$;

grant execute on function public.knowledge_gaps_stats(text[]) to authenticated, service_role;
