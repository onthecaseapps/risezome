-- U9a: Per-meeting event log + card/synthesis/gap artifacts.
--
-- Four tables, all org-scoped via RLS:
--
--   meeting_events  — append-only event log. event_id bigserial gives
--                     us a monotonic per-row id that the live page uses
--                     for reconnect-replay (fetch where event_id > lastSeen).
--   cards           — surfaced retrieval cards. retracted_at soft-delete
--                     (R23a — never DELETE; portal needs the historical
--                     record on reconnect-fetch).
--   syntheses       — running/done/errored LLM syntheses across cards.
--                     accumulated_text grows during delta streaming.
--   gaps            — verbatim questions detected by the gap detector.
--                     Can convert to cards (converted_to_card_id).
--
-- The bot-worker writes all four; the portal reads via RLS.

------------------------------------------------------------
-- meeting_events
------------------------------------------------------------

create table public.meeting_events (
  event_id     bigserial   primary key,
  meeting_id   uuid        not null references public.meetings(meeting_id) on delete cascade,
  org_id       uuid        not null references public.orgs(id) on delete cascade,
  type         text        not null,                            -- 'card' | 'cardUpdated' | 'cardRetracted' | 'synthesisStart' | 'synthesisDelta' | 'synthesisDone' | 'synthesisError' | 'synthesisRetracted' | 'meetingStatus' | 'gap'
  payload      jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index meeting_events_meeting_id_event_id_idx
  on public.meeting_events (meeting_id, event_id);

create index meeting_events_org_id_idx on public.meeting_events (org_id);

alter table public.meeting_events enable row level security;

create policy "members read their org's meeting events"
  on public.meeting_events for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- cards
------------------------------------------------------------

create table public.cards (
  card_id          text        primary key,                     -- engine-generated id (UUID-like)
  meeting_id       uuid        not null references public.meetings(meeting_id) on delete cascade,
  org_id           uuid        not null references public.orgs(id) on delete cascade,
  doc_id           text,                                        -- source doc id (matches docs.id when from corpus)
  source           text        not null,                        -- 'github' | 'jira' | 'live-skill' | ...
  type             text        not null,                        -- 'file' | 'issue' | 'pr' | ...
  title            text        not null default '',
  snippet          text        not null default '',
  score            double precision not null default 0,
  rank             int         not null default 0,
  metadata         jsonb       not null default '{}'::jsonb,
  surfaced_at      timestamptz not null default now(),
  triggered_by     text        not null,                        -- 'window' | 'question' | 'question-provisional'
  utterance_id     text,                                        -- nullable; may not be tied to a single utterance
  trace_id         text        not null,
  url              text,
  pinned           boolean     not null default false,
  pinned_at        timestamptz,
  retracted_at     timestamptz,                                 -- soft-delete; null = visible
  retracted_reason text,                                        -- 'verifier-downgraded' | 'meeting-ended' | 'manual-dismiss'
  created_at       timestamptz not null default now()
);

create index cards_meeting_id_created_at_idx on public.cards (meeting_id, created_at);
create index cards_org_id_idx on public.cards (org_id);
create index cards_meeting_id_pinned_idx on public.cards (meeting_id) where pinned = true;

alter table public.cards enable row level security;

create policy "members read their org's cards"
  on public.cards for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

-- Users can flip the pinned bit on cards in their org. Service-role
-- writes everything else.
create policy "members pin cards in their org"
  on public.cards for update
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  )
  with check (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- syntheses
------------------------------------------------------------

create table public.syntheses (
  synthesis_id          text        primary key,                -- engine-generated
  meeting_id            uuid        not null references public.meetings(meeting_id) on delete cascade,
  org_id                uuid        not null references public.orgs(id) on delete cascade,
  source_card_ids       jsonb       not null default '[]'::jsonb,
  accumulated_text      text        not null default '',
  status                text        not null default 'running'
                                    check (status in ('running', 'done', 'errored', 'retracted')),
  stop_reason           text,
  error_code            text,
  error_message         text,
  citations             jsonb       not null default '[]'::jsonb,
  input_tokens          int,
  output_tokens         int,
  cache_read_tokens     int,
  cache_creation_tokens int,
  ttft_ms               int,
  latency_ms            int,
  trace_id              text        not null,
  retracted_at          timestamptz,
  retracted_reason      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index syntheses_meeting_id_created_at_idx on public.syntheses (meeting_id, created_at);
create index syntheses_org_id_idx on public.syntheses (org_id);

alter table public.syntheses enable row level security;

create policy "members read their org's syntheses"
  on public.syntheses for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

create trigger syntheses_set_updated_at
  before update on public.syntheses
  for each row
  execute function public.set_updated_at();

------------------------------------------------------------
-- gaps
------------------------------------------------------------

create table public.gaps (
  gap_id                 text        primary key,
  meeting_id             uuid        not null references public.meetings(meeting_id) on delete cascade,
  org_id                 uuid        not null references public.orgs(id) on delete cascade,
  utterance_id           text,
  verbatim_question      text        not null,
  context_window         text        not null default '',
  sources_searched       jsonb       not null default '[]'::jsonb,
  intent                 text,
  entities               jsonb       not null default '[]'::jsonb,
  confirmed              boolean     not null default false,
  dismissed              boolean     not null default false,
  converted_to_card_id   text,                                  -- nullable FK to cards.card_id (no constraint — card may not exist yet)
  created_at             timestamptz not null default now()
);

create index gaps_meeting_id_created_at_idx on public.gaps (meeting_id, created_at);
create index gaps_org_id_idx on public.gaps (org_id);

alter table public.gaps enable row level security;

create policy "members read their org's gaps"
  on public.gaps for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

create policy "members confirm/dismiss gaps in their org"
  on public.gaps for update
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  )
  with check (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );
