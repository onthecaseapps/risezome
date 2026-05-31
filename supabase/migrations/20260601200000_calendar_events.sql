-- U6a: Calendar event storage for the meetings pipeline.
--
-- Rows are owned by a (user_id, org_id) pair — the user is the
-- calendar owner; org_id binds the event to whichever Risezome
-- workspace the user is acting in at sign-in time (resolved by the
-- sync function from the user's first membership, since Google
-- accounts are user-owned not org-owned).
--
-- Identity: Google's event id is unique per calendar but the same
-- meeting can show up on multiple calendars (e.g., your invite +
-- the organizer's series); we still store one row per (user_id,
-- event_id) so two users in the same org each see their own copy.
--
-- bot_optin is the user-set "send Risezome to this meeting" toggle.
-- Preserved across syncs so reschedules don't reset opt-in (the sync
-- function upserts everything else but leaves bot_optin alone).
--
-- platform: 'zoom' | 'meet' | 'other' | null. Drives whether the
-- opt-in toggle is enabled in the UI (Recall.ai supports zoom/meet
-- in the MVP; teams is 'other' until later).

create table public.calendar_events (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  org_id            uuid        not null references public.orgs(id) on delete cascade,
  event_id          text        not null,                       -- Google's event id
  ical_uid          text,                                       -- iCalUID for cross-calendar dedup later
  title             text        not null default '',
  description       text,
  start_at          timestamptz not null,
  end_at            timestamptz not null,
  conference_url    text,
  platform          text        check (platform in ('zoom', 'meet', 'other')),
  attendee_count    int         not null default 0,
  is_organizer      boolean     not null default false,
  bot_optin         boolean     not null default false,
  raw               jsonb       not null default '{}'::jsonb,   -- minimal copy of the Google event for debugging
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, event_id)
);

create index calendar_events_user_id_start_at_idx on public.calendar_events (user_id, start_at);
create index calendar_events_org_id_start_at_idx on public.calendar_events (org_id, start_at);
create index calendar_events_start_at_idx on public.calendar_events (start_at);

alter table public.calendar_events enable row level security;

-- Members of the org see their org's events. The user_id column also
-- belongs to a member of the same org, so this scopes to "my org's
-- calendar events" rather than "only mine" — letting teammates see
-- each other's meetings is the intended posture for the Upcoming page.
create policy "members read their org's calendar events"
  on public.calendar_events for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

-- Only the meeting's owning user can toggle bot_optin via the portal.
-- The sync function uses the service-role client to upsert the other
-- columns; that bypasses RLS but always filters by user_id explicitly.
create policy "users update bot_optin on their own events"
  on public.calendar_events for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Reuse the set_updated_at trigger function from U4b's sources migration.
create trigger calendar_events_set_updated_at
  before update on public.calendar_events
  for each row
  execute function public.set_updated_at();
