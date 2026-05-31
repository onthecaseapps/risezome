-- #3 — Workspace bot settings.
--
-- One row per org. Three booleans drive how the meeting bot behaves
-- by default:
--
--   auto_join          — if true, the bot joins every meeting on
--                        connected calendars without per-meeting
--                        opt-in. Default FALSE per R8 (per-meeting
--                        opt-in is the spec'd consent posture).
--   record_transcribe  — if true (default), the bot records audio for
--                        transcription. If false the bot still joins
--                        but the live page shows nothing. Useful for
--                        consent-mode previews.
--   announce_on_join   — if true (default), the bot posts a chat
--                        message announcing itself when it joins.
--                        R10 commits to announcing; the toggle is
--                        for workspaces with custom consent posters
--                        that already cover the announcement.
--
-- Row absent ⇒ all defaults apply. The settings page upserts.
-- Updated_at trigger reused from earlier migrations.

create table public.workspace_bot_settings (
  org_id              uuid        primary key references public.orgs(id) on delete cascade,
  auto_join           boolean     not null default false,
  record_transcribe   boolean     not null default true,
  announce_on_join    boolean     not null default true,
  updated_at          timestamptz not null default now(),
  updated_by          uuid        references auth.users(id) on delete set null
);

alter table public.workspace_bot_settings enable row level security;

-- Org members can READ their workspace's settings.
create policy "members read their workspace bot settings"
  on public.workspace_bot_settings for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

-- Org members can WRITE (upsert) their workspace's settings. A future
-- migration can narrow this to owner/admin roles when we add role
-- gating; for the MVP any member can change settings.
create policy "members upsert their workspace bot settings (insert)"
  on public.workspace_bot_settings for insert
  to authenticated
  with check (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

create policy "members upsert their workspace bot settings (update)"
  on public.workspace_bot_settings for update
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

create trigger workspace_bot_settings_set_updated_at
  before update on public.workspace_bot_settings
  for each row
  execute function public.set_updated_at();
