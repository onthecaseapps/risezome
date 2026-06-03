------------------------------------------------------------
-- Knowledge Gaps (plan U1)
--   docs/plans/2026-06-02-002-feat-knowledge-gaps-plan.md
--
-- Replaces the vestigial per-meeting `gaps` table (scaffolded in
-- 20260602000000, never written to) with a normalized, cross-meeting model:
--
--   knowledge_gap_sections — editable groupings (auto-clustered, manager-curated)
--   knowledge_gaps         — one deduped gap, demand-ranked, with a lifecycle
--   gap_occurrences        — one row per ask (frequency + transcript anchor)
--   gap_viewers            — per-gap visibility ACL (KTD1)
--   meeting_gap_misses     — raw capture staging, consumed by the assembly job
--   notifications          — in-app assignment / resurface notices
--
-- RLS is enabled here (deny-all to clients until U2 adds policies); the
-- assembly job and server actions write via the service role.
------------------------------------------------------------

-- Drop the unused per-meeting gaps table. Nothing in apps/ or packages/ reads
-- or writes it (zero call sites). Its participant-scoped policies from
-- 20260603330000_visibility_and_config_rls.sql are dropped with it (cascade).
-- The viewer-ACL model (KTD1) supersedes that visibility scheme.
drop table if exists public.gaps cascade;

------------------------------------------------------------
-- knowledge_gap_sections
------------------------------------------------------------

create table public.knowledge_gap_sections (
  section_id   text         primary key,
  org_id       uuid         not null references public.orgs(id) on delete cascade,
  name         text         not null,
  color        text         not null default 'slate',
  -- name_locked: set when a manager renames/merges/splits this section, so the
  -- re-clustering step never renames or restructures it (KTD6 / AE3).
  name_locked  boolean      not null default false,
  centroid     vector(1024),
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);

create index knowledge_gap_sections_org_id_idx on public.knowledge_gap_sections (org_id);

create trigger knowledge_gap_sections_set_updated_at
  before update on public.knowledge_gap_sections
  for each row
  execute function public.set_updated_at();

------------------------------------------------------------
-- knowledge_gaps
------------------------------------------------------------

create table public.knowledge_gaps (
  gap_id                text         primary key,
  org_id                uuid         not null references public.orgs(id) on delete cascade,
  -- null section_id == the "Uncategorized" bucket (R9).
  section_id            text         references public.knowledge_gap_sections(section_id) on delete set null,
  title                 text         not null,                                  -- canonical phrasing (first occurrence)
  embedding             vector(1024),                                           -- set by the assembly job after embed
  status                text         not null default 'open'
                                       check (status in ('open','resolved','dismissed')),
  assignee_id           uuid         references auth.users(id) on delete set null,
  frequency             integer      not null default 0,
  shared_with_org       boolean      not null default false,                    -- KTD1 "share with org"
  -- section_pinned: set when a manager moves this gap, so re-clustering never
  -- re-places it (KTD6 / AE3).
  section_pinned        boolean      not null default false,
  reopened_after_close  boolean      not null default false,                    -- R16 "asked again after closing"
  reopened_at           timestamptz,
  first_asked_at        timestamptz,
  last_asked_at         timestamptz,
  assigned_by           uuid         references auth.users(id) on delete set null,
  assigned_at           timestamptz,
  resolved_by           uuid         references auth.users(id) on delete set null,
  resolved_at           timestamptz,
  dismissed_by          uuid         references auth.users(id) on delete set null,
  dismissed_at          timestamptz,
  created_at            timestamptz  not null default now(),
  updated_at            timestamptz  not null default now()
);

-- Demand-ranked library reads: most-asked open gaps in an org, first.
create index knowledge_gaps_org_status_freq_idx
  on public.knowledge_gaps (org_id, status, frequency desc);
create index knowledge_gaps_section_id_idx on public.knowledge_gaps (section_id);
create index knowledge_gaps_assignee_id_idx on public.knowledge_gaps (assignee_id);
-- Semantic-merge nearest-neighbour search (KTD5). HNSW + cosine, mirroring
-- corpus_chunk_embeddings.
create index knowledge_gaps_embedding_hnsw_idx
  on public.knowledge_gaps
  using hnsw (embedding vector_cosine_ops);

create trigger knowledge_gaps_set_updated_at
  before update on public.knowledge_gaps
  for each row
  execute function public.set_updated_at();

------------------------------------------------------------
-- gap_occurrences
------------------------------------------------------------
--
-- One row per individual ask. Gives R5 frequency + occurrence list and R20
-- transcript anchoring (meeting_id + utterance_id). The unique
-- (meeting_id, utterance_id) is the idempotency backstop (KTD4): an assembly
-- retry can never record the same ask twice, and a gap merge re-points these
-- rows (gap_id changes) without violating it.

create table public.gap_occurrences (
  occurrence_id      bigserial    primary key,
  gap_id             text         not null references public.knowledge_gaps(gap_id) on delete cascade,
  org_id             uuid         not null references public.orgs(id) on delete cascade,
  meeting_id         uuid         not null references public.meetings(meeting_id) on delete cascade,
  utterance_id       text,
  verbatim_question  text         not null,
  asker_name         text         not null default 'Unknown',                  -- transcript speaker (may be Unknown)
  asker_user_id      uuid         references auth.users(id) on delete set null, -- when resolvable to a member
  reason             text         not null check (reason in ('no_hits','refusal','ungrounded')),
  asked_at           timestamptz  not null default now(),
  created_at         timestamptz  not null default now(),
  unique (meeting_id, utterance_id)
);

create index gap_occurrences_gap_id_idx on public.gap_occurrences (gap_id);
create index gap_occurrences_meeting_id_idx on public.gap_occurrences (meeting_id);

------------------------------------------------------------
-- gap_viewers (per-gap visibility ACL — KTD1)
------------------------------------------------------------
--
-- Seeded from the participants of every meeting an occurrence came from;
-- unioned on merge; the assignee is added on assignment. A gap with
-- shared_with_org = true bypasses this list entirely (visible org-wide).

create table public.gap_viewers (
  gap_id      text         not null references public.knowledge_gaps(gap_id) on delete cascade,
  user_id     uuid         not null references auth.users(id) on delete cascade,
  org_id      uuid         not null references public.orgs(id) on delete cascade,
  created_at  timestamptz  not null default now(),
  primary key (gap_id, user_id)
);

create index gap_viewers_user_id_idx on public.gap_viewers (user_id);

------------------------------------------------------------
-- meeting_gap_misses (raw capture staging — KTD3)
------------------------------------------------------------
--
-- The bot-worker inserts one row the moment synthesis can't ground an answer.
-- The post-meeting assembly job consumes unprocessed rows for a meeting, then
-- stamps processed_at (durable marker written last — KTD4).

create table public.meeting_gap_misses (
  miss_id            bigserial    primary key,
  meeting_id         uuid         not null references public.meetings(meeting_id) on delete cascade,
  org_id             uuid         not null references public.orgs(id) on delete cascade,
  utterance_id       text,
  verbatim_question  text         not null,
  reason             text         not null check (reason in ('no_hits','refusal','ungrounded')),
  asker_name         text         not null default 'Unknown',
  sources_searched   jsonb        not null default '[]'::jsonb,
  intent             text,
  entities           jsonb        not null default '[]'::jsonb,
  processed_at       timestamptz,
  created_at         timestamptz  not null default now()
);

-- The assembly job's hot read: unprocessed misses for one meeting.
create index meeting_gap_misses_unprocessed_idx
  on public.meeting_gap_misses (meeting_id)
  where processed_at is null;

------------------------------------------------------------
-- notifications (in-app — KTD7)
------------------------------------------------------------

create table public.notifications (
  notification_id  bigserial    primary key,
  user_id          uuid         not null references auth.users(id) on delete cascade,  -- recipient
  org_id           uuid         not null references public.orgs(id) on delete cascade,
  type             text         not null check (type in ('gap_assigned','gap_resurfaced')),
  gap_id           text         references public.knowledge_gaps(gap_id) on delete cascade,
  actor_id         uuid         references auth.users(id) on delete set null,
  read_at          timestamptz,
  created_at       timestamptz  not null default now()
);

-- Unread-count + feed reads, scoped to a recipient.
create index notifications_user_unread_idx on public.notifications (user_id, read_at);

------------------------------------------------------------
-- RLS (deny-all until U2 installs policies; service role bypasses)
------------------------------------------------------------

alter table public.knowledge_gap_sections enable row level security;
alter table public.knowledge_gaps         enable row level security;
alter table public.gap_occurrences        enable row level security;
alter table public.gap_viewers            enable row level security;
alter table public.meeting_gap_misses     enable row level security;
alter table public.notifications          enable row level security;
