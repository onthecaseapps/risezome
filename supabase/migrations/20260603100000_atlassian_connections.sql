-- Extend the source-connector foundation for Atlassian (Jira + Confluence) and
-- add the OAuth-with-refresh connection store. Two source kinds (jira,
-- confluence) hang off one org-level Atlassian connection.

------------------------------------------------------------
-- atlassian_connections
------------------------------------------------------------
--
-- One org-level Atlassian OAuth 2.0 (3LO) connection. Unlike Trello's static
-- token, Atlassian tokens expire and the refresh token ROTATES on each refresh,
-- so we store access + refresh + expiry + the cloud site (cloudId). These are
-- SECRETS: RLS enabled with NO policies, so only the service-role client reads
-- or writes them — mirroring trello_connections / pending_installations.

create table public.atlassian_connections (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.orgs(id) on delete cascade,
  access_token  text        not null,
  refresh_token text        not null,                 -- rotates on refresh
  expires_at    timestamptz not null,                 -- access-token expiry
  cloud_id      text        not null,                 -- Atlassian site (cloudId)
  site_url      text,                                 -- e.g. https://acme.atlassian.net
  scopes        text,                                 -- granted scopes (space-separated)
  connected_at  timestamptz not null default now(),
  unique (org_id)                                     -- one Atlassian connection per org
);

create index atlassian_connections_org_id_idx on public.atlassian_connections (org_id);

alter table public.atlassian_connections enable row level security;
-- No policies: service-role only. Tokens must never be readable by members.

------------------------------------------------------------
-- sources: add the two Atlassian kinds
------------------------------------------------------------

-- Extend the kind discriminator.
alter table public.sources drop constraint if exists sources_kind_check;
alter table public.sources
  add constraint sources_kind_check
  check (kind in ('github', 'trello', 'jira', 'confluence'));

-- connection_id is now polymorphic — it points at trello_connections for Trello
-- sources and atlassian_connections for Jira/Confluence sources, resolved by
-- `kind` in app code. Drop the Trello-only FK; per-kind integrity is enforced by
-- the identity check below, and org deletion still cascades to sources via org_id.
alter table public.sources drop constraint if exists sources_connection_id_fkey;

-- Per-kind identity: GitHub carries an installation; every connection-backed
-- kind carries a connection + an external id.
alter table public.sources drop constraint if exists sources_kind_identity_chk;
alter table public.sources
  add constraint sources_kind_identity_chk check (
    (kind = 'github' and installation_id is not null) or
    (
      kind in ('trello', 'jira', 'confluence')
      and connection_id is not null
      and external_id is not null
    )
  );

-- One source row per Atlassian resource (Jira project / Confluence space) per org.
create unique index sources_atlassian_resource_uq
  on public.sources (org_id, kind, external_id)
  where kind in ('jira', 'confluence');
