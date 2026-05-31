-- Generalize the `sources` model so a source need not be a GitHub install,
-- and add Trello connection storage. Trello is the first non-GitHub source;
-- this is the foundation the next connectors (Jira, Slack) reuse.
--
--   * sources.kind         — connector discriminator ('github' | 'trello')
--   * installation_id      — now nullable (GitHub-only)
--   * repo_full_name       — now nullable (GitHub-only)
--   * connection_id        — FK to trello_connections (Trello-only)
--   * external_id          — generic per-kind external id (Trello board id)
--   * display_name         — generic human label (Trello board name)
--   * trello_connections   — one org-level Trello read token (service-role only)
--
-- The corpus layer (docs/doc_chunks/embeddings) is already source-agnostic:
-- docs.source is free-text, so 'trello' needs no change there.

------------------------------------------------------------
-- trello_connections
------------------------------------------------------------
--
-- One org-level Trello connection. The token is a read-scoped Trello user
-- token (Trello has no org/app install). It is a SECRET: this table has RLS
-- enabled with NO policies, so only the service-role client can read or write
-- it — mirroring `pending_installations`. The Sources page reads connection
-- existence + lists boards server-side via the service-role client.
--
-- expires_at is nullable: today's tokens use expiration=never, but Trello's
-- OAuth 2.0 migration (RFC-89) will introduce expiry — storing it now keeps the
-- eventual refresh a contained change.

create table public.trello_connections (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.orgs(id) on delete cascade,
  token         text        not null,                 -- read-scoped Trello token (secret)
  member_id     text        not null,                 -- Trello member id (from /members/me)
  username      text,
  expires_at    timestamptz,                          -- null = non-expiring (current); set under OAuth2
  connected_at  timestamptz not null default now(),
  unique (org_id)                                     -- one org-level Trello connection per org
);

create index trello_connections_org_id_idx on public.trello_connections (org_id);

alter table public.trello_connections enable row level security;
-- No policies: service-role only. The token must never be readable by members.

------------------------------------------------------------
-- sources: generalize for non-GitHub kinds
------------------------------------------------------------

alter table public.sources
  add column kind text not null default 'github'
    check (kind in ('github', 'trello'));

-- GitHub-specific columns become nullable so Trello rows can omit them.
alter table public.sources alter column installation_id drop not null;
alter table public.sources alter column repo_full_name  drop not null;

-- Generic per-kind identity (Trello uses these; GitHub keeps repo_full_name).
alter table public.sources
  add column connection_id uuid references public.trello_connections(id) on delete cascade,
  add column external_id   text,                       -- Trello board id (immutable)
  add column display_name  text;                       -- Trello board name

create index sources_connection_id_idx on public.sources (connection_id);

-- Per-kind identity: GitHub rows carry an installation; Trello rows carry a
-- connection + board id. Existing rows are all GitHub with an installation, so
-- this holds on backfill.
alter table public.sources
  add constraint sources_kind_identity_chk check (
    (kind = 'github' and installation_id is not null) or
    (kind = 'trello' and connection_id is not null and external_id is not null)
  );

-- One source row per Trello board per org. (The existing
-- unique(installation_id, repo_full_name) only constrains GitHub rows, since
-- both columns are null for Trello and NULLs compare distinct.)
create unique index sources_trello_board_uq
  on public.sources (org_id, external_id)
  where kind = 'trello';
