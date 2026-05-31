-- U5a: Corpus storage for the cloud indexer.
--
-- Three tables modelled on the daemon's SQLite corpus
-- (apps/daemon/src/corpus/migrations/0001_init.sql, 0002_vec.sql) but
-- adapted for Postgres + pgvector + multi-tenant RLS:
--
--   docs                       — per-document metadata, scoped to (org_id, source_id)
--   doc_chunks                 — text chunks of those docs
--   corpus_chunk_embeddings    — vector(1024) embeddings, separate table so
--                                index management (HNSW build, reindex) stays
--                                independent of doc_chunks row lifecycle
--   cursors                    — per-source incremental-sync state (etag, etc.)
--
-- Dimension: Voyage embeddings are 1024-dim (voyage-3-large for text,
-- voyage-code-3 for code). The dimension is locked into the schema; changing
-- it requires a new migration + reindex of all embeddings.
--
-- RLS: every org-scoped table denies SELECT/INSERT/UPDATE/DELETE unless the
-- requesting user is a member of the row's org_id. Writes from Inngest
-- functions and the bot-worker happen via the service-role client (bypasses
-- RLS); those writers must always explicitly filter by org_id, enforced at
-- the @risezome/db-client wrapper layer (lands later).

------------------------------------------------------------
-- pgvector extension
------------------------------------------------------------
create extension if not exists vector;

------------------------------------------------------------
-- docs
------------------------------------------------------------

create table public.docs (
  id              text        primary key,                         -- canonical id from the source (e.g. "github:owner/repo:path@sha")
  org_id          uuid        not null references public.orgs(id) on delete cascade,
  source_id       uuid        not null references public.sources(id) on delete cascade,
  source          text        not null,                            -- 'github', 'jira', etc.
  type            text        not null,                            -- 'file', 'issue', 'pr', etc.
  title           text        not null default '',
  body_summary    text        not null default '',                 -- short summary for quick UI render
  entities        jsonb       not null default '[]'::jsonb,
  authors         jsonb       not null default '[]'::jsonb,
  url             text,
  acl             jsonb       not null default '{}'::jsonb,
  provenance      text        not null default 'untrusted' check (provenance in ('trusted', 'untrusted')),
  updated_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

create index docs_org_id_idx on public.docs (org_id);
create index docs_source_id_idx on public.docs (source_id);
create index docs_updated_at_idx on public.docs (updated_at);

alter table public.docs enable row level security;

create policy "members read their org's docs"
  on public.docs for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- doc_chunks
------------------------------------------------------------
--
-- One row per indexable chunk of a doc. `text` is the raw chunk content
-- the embedder consumed; `position` is the in-doc ordering (0-based).
-- domain is the embedder-routing hint: text chunks go through voyage-3-large,
-- code chunks through voyage-code-3.

create table public.doc_chunks (
  chunk_id        text        primary key,                         -- "<doc_id>::<position>" by convention
  org_id          uuid        not null references public.orgs(id) on delete cascade,
  doc_id          text        not null references public.docs(id) on delete cascade,
  domain          text        not null check (domain in ('text', 'code')),
  text            text        not null,
  position        int         not null default 0,
  -- Generated tsvector for future hybrid retrieval. Built from `text`;
  -- GIN-indexed below. Keeping it inline avoids a follow-up migration when
  -- U7's hybrid retrieval lands. english config is the safe default; we can
  -- introduce code-aware tokenization later if needed.
  text_fts        tsvector    generated always as (to_tsvector('english', text)) stored
);

create index doc_chunks_org_id_idx on public.doc_chunks (org_id);
create index doc_chunks_doc_id_idx on public.doc_chunks (doc_id);
create index doc_chunks_text_fts_idx on public.doc_chunks using gin (text_fts);

alter table public.doc_chunks enable row level security;

create policy "members read their org's chunks"
  on public.doc_chunks for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- corpus_chunk_embeddings
------------------------------------------------------------
--
-- Embeddings live in a separate table from doc_chunks for two reasons:
--   1. HNSW index rebuilds + maintenance can take minutes on a large corpus;
--      isolating the vector column keeps doc_chunks' write path fast.
--   2. We may want to support multiple embedding models / dimensions in
--      parallel later; adding more *_embeddings tables is cleaner than
--      forcing them all onto doc_chunks.
--
-- HNSW with vector_cosine_ops: at launch we may have only thousands of
-- chunks, where a sequential scan is fine. But the index cost is low and
-- creating it now avoids a runtime-altering migration later. DQ1 in the
-- plan flagged this as deferrable; we're choosing to land it now.

create table public.corpus_chunk_embeddings (
  chunk_id    text         primary key references public.doc_chunks(chunk_id) on delete cascade,
  org_id      uuid         not null references public.orgs(id) on delete cascade,
  embedding   vector(1024) not null,
  created_at  timestamptz  not null default now()
);

create index corpus_chunk_embeddings_org_id_idx on public.corpus_chunk_embeddings (org_id);
create index corpus_chunk_embeddings_hnsw_idx
  on public.corpus_chunk_embeddings
  using hnsw (embedding vector_cosine_ops);

alter table public.corpus_chunk_embeddings enable row level security;

create policy "members read their org's embeddings"
  on public.corpus_chunk_embeddings for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- cursors
------------------------------------------------------------
--
-- Per-source incremental-sync state. First run does a full sync; subsequent
-- runs use the cursor_token / etag to fetch only changed content. Schema is
-- intentionally minimal — source-specific cursor payload lives in
-- `cursor_token` (typically a JSON blob the source's reader parses).

create table public.cursors (
  org_id              uuid        not null references public.orgs(id) on delete cascade,
  source_id           uuid        not null references public.sources(id) on delete cascade,
  cursor_token        text,
  etag                text,
  last_full_sync_at   timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (org_id, source_id)
);

alter table public.cursors enable row level security;
-- No SELECT policy: cursor state is operational, not user-facing. Service-role
-- only. The indexer Inngest function uses the service-role client.
