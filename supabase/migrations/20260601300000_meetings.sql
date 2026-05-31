-- U8a: Meeting artifacts — one row per Recall.ai bot launch attempt.
--
-- Lifecycle (status enum):
--   launching        — Inngest function woke up, about to call Recall.ai
--   awaiting_recall  — Recall.ai POST succeeded; waiting for bot to dial in
--   joining          — Recall reports bot is connecting to the meeting
--   waiting_room     — Recall reports bot in waiting room
--   recording        — bot in the meeting + transcribing
--   completed        — meeting ended cleanly
--   failed           — any pre-meeting failure (bad URL, Recall 4xx/5xx,
--                      bot rejected). Carries error_code + error_message.
--
-- Identity: meeting_id UUID is the platform-internal id. recall_bot_id
-- is Recall.ai's id, set once Create Bot returns 2xx. calendar_event_id
-- links back to the source event (FK with ON DELETE SET NULL — if the
-- user deletes the event in Google we keep the meeting record for
-- history but unlink it).
--
-- Idempotency: unique (calendar_event_id) where status != 'failed'
-- prevents double-launch when the toggle is flipped on/off/on quickly
-- and two scheduled-launch events both fire. Failed launches don't
-- count so retries via the kebab work.

create table public.meetings (
  meeting_id         uuid        primary key default gen_random_uuid(),
  org_id             uuid        not null references public.orgs(id) on delete cascade,
  user_id            uuid        not null references auth.users(id) on delete cascade,
  calendar_event_id  uuid        references public.calendar_events(id) on delete set null,
  recall_bot_id      text,
  status             text        not null default 'launching'
                                 check (status in (
                                   'launching', 'awaiting_recall', 'joining',
                                   'waiting_room', 'recording',
                                   'completed', 'failed'
                                 )),
  error_code         text,
  error_message      text,
  started_at         timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Block double-launch for the same calendar event while a launch is
-- in-flight or active. Failed rows are excluded so the user can retry.
create unique index meetings_active_per_calendar_event_idx
  on public.meetings (calendar_event_id)
  where status <> 'failed' and calendar_event_id is not null;

create index meetings_org_id_idx on public.meetings (org_id);
create index meetings_user_id_idx on public.meetings (user_id);
create index meetings_calendar_event_id_idx on public.meetings (calendar_event_id);
create index meetings_recall_bot_id_idx on public.meetings (recall_bot_id);
create index meetings_status_idx on public.meetings (status);

alter table public.meetings enable row level security;

create policy "members read their org's meetings"
  on public.meetings for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

create trigger meetings_set_updated_at
  before update on public.meetings
  for each row
  execute function public.set_updated_at();
