# Corpus Filtering Policy — Requirements

**Date:** 2026-06-10
**Status:** Brainstorm complete → ready for planning
**Tier:** Deep (feature)

## Problem

The indexer captures every parseable file or entity a source exposes, with no
notion of what belongs in a *knowledge* corpus. Measured on the dev workspace's
own repo (`onthecaseapps/risezome`, 802 indexed file docs):

- **197 (~25%) are test files** (`**/test/**`, `*.test.*`, `*.spec.*`)
- **19 are eval result fixtures** (`apps/bot-worker/eval/reports/*.json`)
- plus build config (`tsconfig.json`, `package.json`, lockfiles)

This noise causes two failures, both observed in the golden-question eval:

1. **Retrieval dilution** — real source loses to noise. "Which embedding model
   is used for code vs prose" retrieves a requirements `.md` at rerank score
   0.016 and synthesis correctly refuses; the actual answer in
   `packages/engine/src/embed/voyage.ts` never surfaces.
2. **Grounded-looking hallucination** — "what database does the corpus use"
   returns a confident, citation-*verified* answer ("SQLite with better-sqlite3
   + sqlite-vec") synthesized from stale `eval/reports/*.json` fixtures that
   describe a defunct prototype. The real stack is Postgres + pgvector.
   Citations "verified" because the quotes genuinely exist in those indexed
   files — the most dangerous failure mode.

The same class of noise exists in connector sources: closed/duplicate Jira
tickets, archived Confluence pages, archived Trello cards, template items.

No mechanism exists to exclude anything today:
`apps/portal/src/inngest/functions/index-repo.ts` filters only by extension
(`classifyFile` in `packages/engine/src/chunker/file-chunker.ts`) and size, and
the `sources` table has no config/policy column.

## Goal

Let a workspace control what each source contributes to the corpus, so indexing
captures knowledge and excludes noise — fixing retrieval quality and
eliminating noise-sourced hallucinations — while staying safe-by-default for the
customers who never open the config.

## Users

- **Primary — workspace admin/manager** configuring sources in the Risezome
  dashboard (consistent with existing `requireAdmin`/`requireManager` gating).
  They pick a preset or tweak excludes when a connected source has a structure
  the default gets wrong (e.g. a Rails repo using `spec/`, a monorepo).
- **Secondary — every customer**, via the default preset. Most never open the
  config, so the default must fix pollution on its own.

## Requirements

### R1 — Policy resolved per source as an ordered merge
A source's effective filter resolves as **org default policy → per-source
override**. The resolver is structured so a future third layer (in-repo
`.risezomeignore`) can be appended without redesign.

### R2 — Two filter kinds, by source type
- **Repo sources (GitHub):** path filters using gitignore-style globs (exclude
  `**/test/**`, `*.spec.*`, `eval/reports/**`, lockfiles, build config, …).
- **Connector sources (Jira / Confluence / Trello):** attribute filters over
  entity metadata — e.g. Jira exclude `status in (Closed, Done)` or
  resolved-before-age; Confluence exclude archived; Trello exclude archived
  cards or named lists.

### R3 — Built-in presets
A small library of presets, each a bundle of rules across source types:
- **Recommended (default):** allowlist-of-intent — index source + docs + active
  connector items; exclude tests/fixtures/eval/snapshots/lockfiles/build-config,
  and closed/archived/template connector items.
- **Index everything:** today's behavior (escape hatch).
- **Code only / Docs only** (or similar narrow presets) as useful.

The Recommended preset applies automatically to new sources — pollution is fixed
with zero configuration.

### R4 — Safe by default, never silent
- The default fails safe: an allowlist of knowledge file types/paths means new
  or unrecognized noise is excluded rather than indexed.
- Exclusions are visible: each source shows "indexed N of M · K excluded by
  policy" with a way to see what was dropped, so a customer never silently loses
  content they wanted. Recovery is one step: switch to "Index everything" or add
  an include override.

### R5 — Indexer applies policy; reindex prunes
- The indexer resolves and applies the policy in its target-selection step
  (before chunk/embed) for both repo and connector indexers.
- On reindex, items newly excluded by policy drop out of the desired set and are
  pruned through the existing reconcile path
  (`apps/portal/src/inngest/lib/corpus-reconcile.ts`) — no separate cleanup job.

### R6 — Admin-gated editing
Only admins/managers may change a workspace's default policy or a per-source
override. Changing a source's policy triggers a reindex of that source.

## Scope boundaries

**In v1:**
- Org default + per-source override
- Both filter kinds: repo path globs AND connector attribute filters
- Preset library with a default-on Recommended preset
- Exclusion visibility in the Sources UI
- Prune-on-reindex via existing reconcile

**Deferred (designed-for, not built):**
- In-repo `.risezomeignore` file as a third resolution layer
- Content-heuristic filtering (dropping low-value files by model/heuristic
  rather than by path/attribute)

**Outside this feature's identity:**
- A per-file manual include/exclude curation UI — this is a glob/preset *policy*,
  not a file browser.

## Success criteria

- The two observed eval failures are fixed: "what database does the corpus use"
  no longer returns the SQLite hallucination (its source files are excluded),
  and code-config questions retrieve real source.
- On the dev workspace, the Recommended preset excludes the ~197 test + 19
  eval-report docs; a full reindex prunes them.
- A regression golden question locks the pollution case (asserts the "what
  database" question does NOT answer SQLite — grounded in real Postgres source
  or a refusal).
- No measurable over-exclusion: relevant-bucket pass rate does not drop.

## Dependencies / Assumptions

- Reconcile prune removes excluded-but-previously-indexed docs on the next full
  reindex (expected; confirm in planning).
- Connector attribute filtering assumes the needed metadata (status, archived,
  labels, dates) is already fetched by the existing connector indexers
  (`index-jira.ts`, `index-confluence.ts`, `index-trello.ts`) — verify per
  connector in planning.

## Open questions for planning

- Exact preset definitions and the Recommended default's full glob + attribute
  rule set.
- Data model: where the per-source override lives (a `sources` column vs a new
  table) and how the org default is stored.
- Whether a preset/override change reindexes eagerly or on the next scheduled run.
- Pattern syntax: confirm gitignore semantics (including `!` negation / include
  overrides) for the override editor.
