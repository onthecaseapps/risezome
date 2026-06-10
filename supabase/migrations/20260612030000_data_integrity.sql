-- Data-integrity hardening (deep-review findings). Behavior-preserving except
-- where noted; each block is independent.

------------------------------------------------------------
-- H1 guard: docs/doc_chunks/corpus_chunk_embeddings ids are GLOBAL text PKs
-- derived from external identity (e.g. trello:{board}:{card}) with no org
-- component. Two orgs connecting the same external resource would upsert the
-- same PK and SILENTLY steal each other's rows (the second upsert rewrites
-- org_id). Until ids are org-scoped, turn that silent theft into a loud error:
-- an UPDATE may never move a row across orgs.
------------------------------------------------------------
create or replace function public.forbid_org_move()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'cross-org id collision: % cannot move from org % to org %',
      tg_table_name, old.org_id, new.org_id;
  end if;
  return new;
end;
$$;

drop trigger if exists docs_forbid_org_move on public.docs;
create trigger docs_forbid_org_move
  before update of org_id on public.docs
  for each row execute function public.forbid_org_move();

drop trigger if exists doc_chunks_forbid_org_move on public.doc_chunks;
create trigger doc_chunks_forbid_org_move
  before update of org_id on public.doc_chunks
  for each row execute function public.forbid_org_move();

drop trigger if exists corpus_chunk_embeddings_forbid_org_move on public.corpus_chunk_embeddings;
create trigger corpus_chunk_embeddings_forbid_org_move
  before update of org_id on public.corpus_chunk_embeddings
  for each row execute function public.forbid_org_move();

------------------------------------------------------------
-- H2: a meeting is an ORG artifact — deleting the user who launched it must
-- not cascade away the org's shared transcript/cards/syntheses/gap history.
-- (can_access_meeting's owner branch is null-safe: null user_id simply falls
-- through to the participant/admin branches.)
------------------------------------------------------------
alter table public.meetings drop constraint if exists meetings_user_id_fkey;
alter table public.meetings alter column user_id drop not null;
alter table public.meetings
  add constraint meetings_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

------------------------------------------------------------
-- H3: knowledge_gaps.frequency is denormalized and was only recomputed on
-- ADDITIONS — occurrence deletions (meeting cascade, merges) left ghost gaps
-- "asked N×" with empty drawers and inflated demand ranking. Keep it honest
-- with a delete-side recount, plus a one-off repair of existing drift.
------------------------------------------------------------
-- STATEMENT-level (transition table), not per-row: a per-row trigger over a
-- cascade delete of N occurrences issues N serialized knowledge_gaps updates,
-- each taking a row lock in occurrence order — which deadlocks against the
-- advisory-locked merge/assemble RPCs that lock the same rows in a different
-- order, and is O(N^2) on a big org delete. One grouped update per statement
-- recomputes every affected gap in a single pass.
create or replace function public.gap_occurrences_recount()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  update public.knowledge_gaps g
  set frequency = coalesce(c.n, 0)
  from (select distinct gap_id from deleted_occurrences) d
  left join lateral (
    select count(*) as n from public.gap_occurrences o where o.gap_id = d.gap_id
  ) c on true
  where g.gap_id = d.gap_id;
  return null;
end;
$$;

drop trigger if exists gap_occurrences_recount on public.gap_occurrences;
create trigger gap_occurrences_recount
  after delete on public.gap_occurrences
  referencing old table as deleted_occurrences
  for each statement execute function public.gap_occurrences_recount();

-- One-off repair: realign any already-drifted frequencies.
update public.knowledge_gaps g
set frequency = coalesce(c.n, 0)
from (select gap_id, count(*) as n from public.gap_occurrences group by gap_id) c
where c.gap_id = g.gap_id and g.frequency <> c.n;
update public.knowledge_gaps g
set frequency = 0
where not exists (select 1 from public.gap_occurrences o where o.gap_id = g.gap_id)
  and g.frequency <> 0;

------------------------------------------------------------
-- Section-name uniqueness (recluster race): two concurrent assemblies could
-- both insert near-identical sections — the code's "conflict skip" referenced
-- a constraint that didn't exist. Merge existing duplicates (keep the oldest;
-- repoint gaps), then enforce uniqueness per org (case-insensitive).
------------------------------------------------------------
-- Keeper preference: a manager-curated (name_locked) row wins over an
-- auto-created duplicate, then oldest — so the dedup never drops a deliberate
-- curation flag and the survivor stays locked. The survivor also inherits
-- name_locked if ANY duplicate was locked. Materialized to a temp table so the
-- three follow-up statements share one keeper computation.
create temporary table _section_keepers on commit drop as
  select section_id, org_id,
         first_value(section_id) over (
           partition by org_id, lower(name)
           order by name_locked desc, created_at, section_id
         ) as keeper,
         bool_or(name_locked) over (partition by org_id, lower(name)) as any_locked
  from public.knowledge_gap_sections;

update public.knowledge_gaps g
set section_id = k.keeper
from _section_keepers k
where g.section_id = k.section_id and k.section_id <> k.keeper;

-- Carry forward a lock that lived on a non-keeper duplicate.
update public.knowledge_gap_sections s
set name_locked = true
from _section_keepers k
where s.section_id = k.keeper and k.any_locked and not s.name_locked;

delete from public.knowledge_gap_sections s
using _section_keepers k
where s.section_id = k.section_id and k.section_id <> k.keeper;

create unique index if not exists knowledge_gap_sections_org_name_uq
  on public.knowledge_gap_sections (org_id, lower(name));

------------------------------------------------------------
-- M1: merge_gaps — the manager "merge gap B into A" was a 6-statement
-- non-transactional sequence over PostgREST; a crash after the collide-delete
-- permanently lost occurrence rows. One advisory-locked transaction, mirroring
-- assemble_gap_occurrence_group's locking discipline.
------------------------------------------------------------
create or replace function public.merge_gaps(p_org_id uuid, p_target_gap_id text, p_source_gap_id text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_count int;
begin
  if p_target_gap_id = p_source_gap_id then
    raise exception 'same_gap';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_org_id::text));

  select count(*) into v_count
  from public.knowledge_gaps
  where gap_id in (p_target_gap_id, p_source_gap_id) and org_id = p_org_id;
  if v_count <> 2 then
    raise exception 'not_found';
  end if;

  -- Drop B occurrences that collide with A's (meeting_id, utterance_id) keys
  -- (null-safe equality matches the unique index's NULLS NOT DISTINCT).
  delete from public.gap_occurrences b
  where b.gap_id = p_source_gap_id
    and b.org_id = p_org_id
    and exists (
      select 1 from public.gap_occurrences a
      where a.gap_id = p_target_gap_id
        and a.org_id = p_org_id
        and a.meeting_id = b.meeting_id
        and a.utterance_id is not distinct from b.utterance_id
    );

  update public.gap_occurrences
  set gap_id = p_target_gap_id
  where gap_id = p_source_gap_id and org_id = p_org_id;

  insert into public.gap_viewers (gap_id, user_id, org_id)
  select p_target_gap_id, user_id, org_id
  from public.gap_viewers
  where gap_id = p_source_gap_id and org_id = p_org_id
  on conflict (gap_id, user_id) do nothing;

  update public.knowledge_gaps g
  set frequency = agg.n,
      first_asked_at = least(coalesce(g.first_asked_at, agg.first_at), agg.first_at),
      last_asked_at = greatest(coalesce(g.last_asked_at, agg.last_at), agg.last_at)
  from (
    select count(*) as n, min(asked_at) as first_at, max(asked_at) as last_at
    from public.gap_occurrences
    where gap_id = p_target_gap_id and org_id = p_org_id
  ) agg
  where g.gap_id = p_target_gap_id and g.org_id = p_org_id;

  delete from public.knowledge_gaps
  where gap_id = p_source_gap_id and org_id = p_org_id;
end;
$$;

revoke all on function public.merge_gaps(uuid, text, text) from public;
grant execute on function public.merge_gaps(uuid, text, text) to service_role;

------------------------------------------------------------
-- M3: user_google_tokens.key_org_id had no FK — deleting the custody org left
-- a dangling pointer and an undecryptable token with no re-auth signal.
-- NOT VALID: don't fail the migration on any pre-existing dangler; new writes
-- are enforced. App treats (key_org_id is null AND token present) as
-- "re-auth required".
------------------------------------------------------------
alter table public.user_google_tokens
  drop constraint if exists user_google_tokens_key_org_id_fkey;
alter table public.user_google_tokens
  add constraint user_google_tokens_key_org_id_fkey
  foreign key (key_org_id) references public.orgs(id) on delete set null
  not valid;

------------------------------------------------------------
-- Constraint gaps (NOT VALID where a full-table validation scan is avoidable;
-- all are app-maintained invariants being pinned, not behavior changes).
------------------------------------------------------------
alter table public.org_encryption_keys
  drop constraint if exists org_encryption_keys_status_check;
alter table public.org_encryption_keys
  add constraint org_encryption_keys_status_check
  check (status in ('active', 'disabled', 'rotating')) not valid;

alter table public.knowledge_gaps
  drop constraint if exists knowledge_gaps_frequency_check;
alter table public.knowledge_gaps
  add constraint knowledge_gaps_frequency_check
  check (frequency >= 0) not valid;

-- asker_name rides in a btree index (gap_occurrences_stats_idx) — an unbounded
-- pathological value would fail INSERTs at the index layer with a confusing
-- error; bound it explicitly instead.
alter table public.gap_occurrences
  drop constraint if exists gap_occurrences_asker_name_len;
alter table public.gap_occurrences
  add constraint gap_occurrences_asker_name_len
  check (char_length(asker_name) <= 256) not valid;

alter table public.meetings
  drop constraint if exists meetings_ended_after_started;
alter table public.meetings
  add constraint meetings_ended_after_started
  check (ended_at is null or started_at is null or ended_at >= started_at) not valid;

alter table public.calendar_events
  drop constraint if exists calendar_events_end_after_start;
alter table public.calendar_events
  add constraint calendar_events_end_after_start
  check (end_at >= start_at) not valid;

------------------------------------------------------------
-- Hot-path / lifecycle indexes (cheap btrees; tables are small today, these
-- prevent the org-delete + captures-list scans from degrading as they grow).
------------------------------------------------------------
create index if not exists gap_occurrences_org_id_idx on public.gap_occurrences (org_id);
create index if not exists notifications_org_id_idx on public.notifications (org_id);
create index if not exists meetings_org_created_idx on public.meetings (org_id, created_at desc);
create index if not exists meeting_events_transcript_idx
  on public.meeting_events (meeting_id) where type = 'transcript.data';
