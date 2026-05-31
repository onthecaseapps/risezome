-- U4b: GitHub App installation tracking + per-source state.
--
-- Three tables:
--   github_installations  — one row per GitHub App install. Tracked by
--                           GitHub's numeric installation_id; bound to
--                           an Risezome org via the install-callback
--                           handler. Nullable org_id handles the race
--                           where the webhook fires before the callback.
--   sources              — per-repo indexing state. One row per repo
--                           per installation. Lifecycle: pending → indexing
--                           → idle | errored | removed.
--   pending_installations — short-lived (15 min) CSRF state for the
--                           install flow. The state token binds the
--                           install initiation to the authed user/org
--                           that initiated it.

------------------------------------------------------------
-- github_installations
------------------------------------------------------------

create table public.github_installations (
  installation_id  bigint      primary key,                        -- GitHub's numeric id
  org_id           uuid        references public.orgs(id) on delete cascade,
  account_login    text        not null,                           -- e.g. "acme"
  account_type     text        not null check (account_type in ('Organization', 'User')),
  installed_at     timestamptz not null default now(),
  suspended_at     timestamptz,                                    -- null = active; set by webhook
  removed_at       timestamptz                                     -- null = active; set on uninstall
);

create index github_installations_org_id_idx on public.github_installations (org_id);

alter table public.github_installations enable row level security;

create policy "members read their org's github installations"
  on public.github_installations for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- sources
------------------------------------------------------------

create table public.sources (
  id                uuid        primary key default gen_random_uuid(),
  org_id            uuid        not null references public.orgs(id) on delete cascade,
  installation_id   bigint      not null references public.github_installations(installation_id) on delete cascade,
  repo_full_name    text        not null,                          -- "owner/repo"
  repo_id           bigint,                                        -- GitHub's numeric repo id, for rename tracking
  default_branch    text,
  status            text        not null default 'pending'
                                check (status in ('pending', 'indexing', 'idle', 'errored', 'removed')),
  status_message    text,                                          -- error detail when status = 'errored'
  indexed_files     int         not null default 0,
  total_files       int,                                           -- nullable until the indexer learns the count
  chunk_count       int         not null default 0,
  last_indexed_at   timestamptz,
  removed_at        timestamptz,                                   -- soft-delete on installation_repositories.removed
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (installation_id, repo_full_name)
);

create index sources_org_id_idx on public.sources (org_id);
create index sources_installation_id_idx on public.sources (installation_id);

alter table public.sources enable row level security;

create policy "members read their org's sources"
  on public.sources for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- pending_installations
------------------------------------------------------------
--
-- Short-lived CSRF state. The state_token is a 32-byte hex string we
-- generate at install-initiation time. It's stored here against the
-- (authed) user + org that initiated the install. When GitHub redirects
-- back with the state, the install-callback handler verifies the row
-- exists + not expired and binds the installation to that org_id.
--
-- No RLS policies: this table is server-only, accessed exclusively via
-- the service-role client. Users have no business reading anyone's
-- pending state, including their own.

create table public.pending_installations (
  state_token  text        primary key,
  org_id       uuid        not null references public.orgs(id) on delete cascade,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '15 minutes')
);

create index pending_installations_expires_at_idx on public.pending_installations (expires_at);

alter table public.pending_installations enable row level security;
-- No SELECT/INSERT policies; only service-role can touch this table.

------------------------------------------------------------
-- updated_at trigger for sources
------------------------------------------------------------

create or replace function public.set_updated_at()
  returns trigger
  language plpgsql
  as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sources_set_updated_at
  before update on public.sources
  for each row
  execute function public.set_updated_at();
