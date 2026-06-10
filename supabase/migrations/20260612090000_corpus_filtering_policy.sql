-- Configurable corpus filtering policy (U2).
--
-- Stores the org-default policy and per-source override that the indexer
-- resolves (corpus-policy.ts / corpus-policy-store.ts) to decide what each
-- source contributes to the corpus. Presets themselves live in code; the DB
-- stores only a preset key + optional custom rules.
--
-- RLS follows the repo convention (team_sources / org_members discipline):
-- members read their org's policy, writes go through service-role server
-- actions only (no client write policy, no client UPDATE). Scoped by org_id,
-- the per-org tenancy boundary.

------------------------------------------------------------
-- 1. Org-default policy (one row per org; absent row => 'recommended' in code)
------------------------------------------------------------
create table public.org_corpus_policy (
  org_id          uuid        primary key references public.orgs(id) on delete cascade,
  preset          text        not null default 'recommended'
                              check (preset in ('recommended', 'index_everything', 'code_only')),
  custom_excludes jsonb       not null default '[]'::jsonb,   -- extra gitignore-style path globs
  custom_includes jsonb       not null default '[]'::jsonb,   -- re-include (negation) globs
  connector_rules jsonb       not null default '[]'::jsonb,   -- ConnectorRule[]
  updated_by      uuid,                                       -- auth.uid() of the last editor
  updated_at      timestamptz not null default now()
);

alter table public.org_corpus_policy enable row level security;

-- Members read their org's policy (so the settings UI renders). Writes via
-- service-role server actions only — no client INSERT/UPDATE/DELETE policy.
create policy "members read their org's corpus policy"
  on public.org_corpus_policy for select
  to authenticated
  using (
    org_id in (
      select org_id from public.org_members
      where user_id = (select auth.uid())
    )
  );

------------------------------------------------------------
-- 2. Per-source override + exclusion counter
------------------------------------------------------------
-- corpus_policy: null => inherit the org default. Shape mirrors CorpusPolicy
-- in corpus-policy.ts ({ preset, customExcludes?, customIncludes?, connectorRules? }).
alter table public.sources
  add column corpus_policy jsonb;

-- How many candidate files/entities the active policy excluded on the last
-- index run (drives "indexed N of M . K excluded by policy" in the UI).
alter table public.sources
  add column excluded_count int not null default 0;
