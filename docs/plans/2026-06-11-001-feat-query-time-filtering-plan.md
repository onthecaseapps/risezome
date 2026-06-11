---
title: "feat: Query-time corpus filtering (per-team views of a shared source)"
status: completed
date: 2026-06-11
type: feat
origin: docs/brainstorms/2026-06-11-query-time-filtering-requirements.md
---

# feat: Query-time corpus filtering

## Summary

Let each team see its own filtered **view** of a shared source while the system
stores the **minimal union** that satisfies all teams — the repo is indexed
once, content no team wants is never stored, and a team never retrieves content
its own policy excludes. Resolves the last-write-wins conflict where two teams
that share a repo must also share its filter (today's `sources.corpus_policy` is
per-source and applied at index time).

The mechanism: **store the union, filter per-team at query.** A document is kept
iff at least one referencing team admits it; each indexed chunk carries a
denormalized `visible_team_ids uuid[]` (the teams whose view-policy admits its
doc). At retrieval the search RPCs add one predicate —
`visible_team_ids && <the meeting's attending team ids>` — so a team only sees
what its view allows. Visibility is computed at **index time** with the existing
pure policy matchers (`makePathFilter` / `makeEntityFilter`), so full glob/
attribute expressiveness is preserved and query-time stays a cheap array overlap.

Origin: `docs/brainstorms/2026-06-11-query-time-filtering-requirements.md`.

---

## Problem Frame

Filtering today is index-time and per-source (`sources.corpus_policy`, resolved
org-default → per-source override in `corpus-policy.ts`, applied during indexing
at `index-repo.ts:216` / `connector-index.ts:142` — excluded files are pruned,
so the physical corpus contains only what the policy kept). But the corpus is
org-level and shared: a repo is one `sources` row referenced by many teams via
`team_sources` (canonical corpus deliberately NOT denormalized per team).

So two teams sharing a repo must share its filter: Team A "Code-only" + Team B
"Everything" on `acme/web` both write the single `sources.corpus_policy` →
last-save-wins → both teams get that one result, indexed once. There is no way
to have the repo simultaneously code-only-for-A and everything-for-B.

Verified facts that shape the design:
- **Search is chunk-level, source-filtered, no joins.** `search_corpus_vector`
  (`…/20260612050000_embedding_domain.sql`, 5-arg) and `search_corpus_fts`
  (`…/20260609060000_…`, 4-arg) filter `corpus_chunk_embeddings` / `doc_chunks`
  by a **denormalized `source_id = any(p_source_ids)`** — no join to `docs`.
- **No app-side post-filter.** `retrieval.ts` resolves `effectiveSourceIds` once
  via `meeting_effective_source_ids` and passes them straight to the RPCs
  (`corpus-search.ts:282`). Any per-doc filter MUST be pushed into the RPC.
- **`source_id` is triple-denormalized** (`docs`→`doc_chunks`→
  `corpus_chunk_embeddings`) precisely to keep search join-free — the precedent
  for adding a `visible_team_ids` column the same way.
- **Reconcile is whole-document.** `reconcile()` (`corpus-reconcile.ts:127`)
  diffs a desired docId→hash map vs existing and prunes whole docs;
  `writeReconciledDoc` (`corpus-pg.ts:89`) writes doc+chunks+embeddings in one tx
  and stamps the denormalized `source_id` on chunks/embeddings — the hook for
  stamping `visible_team_ids`.
- **Policy matchers are pure.** `makePathFilter` / `makeEntityFilter` take a
  path/entity → keep boolean; reusable per-team at index time with no I/O.

---

## Requirements

Carried from origin:

- **R1** — Two layers: a per-team **view policy** (what a team may retrieve;
  what the filter editor edits) and a system-derived **storage policy** (the
  union; never edited directly).
- **R2** — Storage is the **minimal union**: a doc is stored iff ≥1 referencing
  team admits it; dropped only when no team wants it. Repo indexed once.
- **R3** — Per-team filtering at **query time**; a meeting's effective view per
  source = the **union** of the attending teams' views (most permissive among
  attendees), matching how effective *sources* already union.
- **R4** — Query-time filter must be cheap + index-friendly (no per-query glob
  eval); visibility precomputed at index time.
- **R5** — Changing a team's view, or the team set, reconciles at **document
  granularity** (index newly-needed, prune now-unwanted) — generalizes the
  per-source refcount to per-document.
- **R6** — Fail safe (never leak excluded content), per-team exclusion
  visibility in the UI, no material retrieval-latency regression, index-once
  preserved.
- **R7** — Admin/manager-gated view editing; storage policy is system-computed.

**Decision (load-bearing, R4): key visibility by `visible_team_ids uuid[]`.**
Considered: (a) per-doc policy-id bitmap + per-source grant mapping, (b)
category/attribute columns. Chosen: store on each chunk the **set of team ids
whose view-policy admits its doc**. This is intrinsically source-scoped (only
teams selecting the doc's source are evaluated), so the query filter is a single
`visible_team_ids && <attending team ids>` overlap with **no cross-source bleed**
and **no separate (source,policy) grant structure** — and it keeps full
glob/attribute expressiveness (evaluated at index time by the existing matchers).
Trade-off: the array is recomputed on a team/policy/membership change (R5), via
the same reindex path. The `enabled` pause stays a separate query-time filter
(it's a runtime toggle, can't be baked at index time) and composes.

---

## Implementation Units

### U1 — Schema: per-team view policy + per-chunk visibility + attendee teams

**Migration** (new, after `20260612100000`):
- `alter table team_sources add column view_policy jsonb;` — per-team view
  (mirrors `CorpusPolicy`; null = inherit org default). What the filter editor
  writes going forward.
- `alter table doc_chunks add column visible_team_ids uuid[] not null default '{}';`
  `alter table corpus_chunk_embeddings add column visible_team_ids uuid[] not null default '{}';`
  Denormalized (like `source_id`/`domain`), with GIN indexes
  (`… using gin (visible_team_ids)`) for the `&&` overlap predicate.
- New `meeting_attendee_team_ids(p_meeting_id uuid) returns setof uuid`
  (security definer, service-role) — the attendees' non-archived teams (the
  same join as `meeting_effective_source_ids` minus the `team_sources` leg).
- Backfill `team_sources.view_policy` from each source's current
  `sources.corpus_policy` so existing behavior is preserved on cutover (U7).

**Test:** RLS unchanged (service-role writes); column defaults `{}` so existing
rows are invisible until backfilled (U7 stamps them).

### U2 — Policy engine: per-team admittance + union keep-gate

**Files:** `apps/portal/src/inngest/lib/corpus-policy.ts`,
`corpus-policy-store.ts`.

**Approach:** add a helper that, given a source's set of `(team_id, resolved
view policy)` plus a doc's path (repo) or entity attrs (connector), returns the
**admitting team ids** using the existing `makePathFilter` / `makeEntityFilter`
(one matcher per distinct view, evaluated per doc). Keep-gate: a doc is kept iff
the admitting set is non-empty (the union). No new "union policy" object — the
union is emergent from per-team admittance.

**Test scenarios:** two views (code-only, everything) over one repo → a `.md`
doc admits only the everything team; a `.ts` doc admits both; a doc admitted by
neither is dropped. Connector attrs likewise (jira Done excluded by recommended,
kept by everything).

### U3 — Indexer integration (repo + connectors)

**Files:** `index-repo.ts`, `connector-index.ts`, `corpus-pg.ts`
(`writeReconciledDoc` / `pgCorpusWriter`), `corpus-reconcile.ts`.

**Approach:**
- Load the source's `team_sources` rows + each team's resolved view policy.
- Replace the single `makePathFilter(policy)` keep-gate with the U2 union gate;
  for each kept doc compute its `visible_team_ids`.
- Thread `visible_team_ids` through `ReconciledDocWrite` → stamp on every
  `doc_chunks` + `corpus_chunk_embeddings` row (alongside the existing
  `source_id` denormalization).
- `excluded_count` becomes "excluded by ALL teams".

**Test:** a written doc's chunks carry the expected `visible_team_ids`; a
union-dropped doc is not written.

### U4 — Retrieval: query-time visibility filter

**Files:** the two search RPCs (new migration `create or replace`),
`apps/bot-worker/src/retrieval.ts`, `corpus-search.ts`.

**Approach:**
- Add `p_team_ids uuid[] default null` to `search_corpus_vector` /
  `search_corpus_fts`; predicate `and (p_team_ids is null or
  c.visible_team_ids && p_team_ids)`. Re-grant the new arity (service-role).
- `retrieval.ts`: resolve `meeting_attendee_team_ids` once per meeting (cache on
  the runtime beside `effectiveSourceIds`); pass as `p_team_ids`. `null` ⇒ the
  unscoped dev path (no team filter), matching today's `effectiveSourceIds`
  undefined behavior.
- Keep the existing `p_source_ids` filter (handles selection + the `enabled`
  pause, which the index-time `visible_team_ids` can't reflect).

**Test:** a fixture corpus with two teams' visibility over one source — a
meeting with only Team A retrieves only A-visible chunks; Team B's meeting gets
B's; an attendee in neither team gets nothing. **No-leakage assertion is the
critical test.**

### U5 — UI: filter editor edits the per-team view

**Files:** `_card-filter-editor.tsx`, a new `set-team-source-policy-action.ts`
(or extend `corpus-policy-action.ts`), `page.tsx`.

**Approach:** the card's filter now reads/writes **`team_sources.view_policy`**
for the selected team (admin-gated, service-role), not the shared
`sources.corpus_policy`. The pill/preset reflects the team's view. Exclusion
visibility becomes per-team: "you retrieve N of M documents in this source."
Saving triggers the U6 reconcile.

**Test:** saving a view writes `team_sources.view_policy` for the right
(team, source) and triggers reindex; two teams show independent presets on the
same source.

### U6 — Reconcile on view / membership change

**Files:** `team-source-lifecycle.ts`, the new policy action, the indexer event.

**Approach:** editing a team's view, or add/remove of a `team_sources` row,
re-indexes the affected source under the recomputed union (re-fetch + restamp
`visible_team_ids`), pruning docs no team wants and indexing newly-admitted
ones through the existing reconcile. Document-granular: a doc whose
`visible_team_ids` would become empty is pruned; a doc newly admitted by a
widened view is fetched + written. No whole-repo churn when another team still
needs the content (only the delta changes).

**Test:** code-only Team A indexes a repo (no `.md`); adding everything Team B
backfills the `.md` docs (now `visible_team_ids = {B}`) without dropping A's
code; removing B prunes the `.md` docs again.

### U7 — Migration / backfill (no behavior change on cutover)

**Approach:**
- Backfill `team_sources.view_policy` ← the source's current
  `sources.corpus_policy` (each team inherits today's per-source policy as its
  view), so retrieval is unchanged at cutover.
- Stamp `visible_team_ids` on the existing corpus: a one-time backfill that, per
  source, evaluates each selecting team's view against existing docs and writes
  the array — OR a full reindex of all sources under the new path. Decide in
  execution (backfill is cheaper but must re-derive each doc's path/attrs;
  reindex is simpler but heavier). Until stamped, `visible_team_ids = {}` ⇒ a
  doc is invisible, so the backfill MUST run before U4's predicate goes live (or
  the predicate treats empty as "fall back to source-scope only" during
  migration — safer; gate with a flag).

**Test:** post-backfill, every meeting's retrieval set is identical to
pre-change (golden-question parity).

### U8 — Tests + eval parity

Unit: U2 union/admittance, RPC visibility predicate (no leakage), reconcile-on-
change (U6 scenario). Integration: the motivating case end-to-end. Eval: the
golden-question relevant-bucket pass rate does not regress; add a regression
lock that a code-only team does not retrieve a docs-only chunk from a shared
repo.

---

## Scope boundaries

**In v1:** per-team view policy; union storage; per-chunk `visible_team_ids`;
query-time filter in the search RPCs; document-granular reconcile on change;
per-team exclusion visibility; backfill with retrieval parity.

**Deferred (designed-for):** per-*user* views; content-heuristic visibility; a
storage-cost indicator / soft cap when an "everything" team forces full storage.

**Outside this feature's identity:** not a per-file curation UI (still
glob/preset/attribute policy); not a change to dedup/refcount/index-once; not the
`enabled` pause (composes, separate).

## Risks

- **Visibility churn:** a team/policy/membership change recomputes
  `visible_team_ids` via reindex. Bounded by the source's doc count; reuses
  reconcile. Worst case is an "everything" team added to a large repo (a real
  reindex) — same cost as a filter change today.
- **Hot-path column + GIN on search tables:** `visible_team_ids` overlap must
  stay index-friendly alongside the HNSW/FTS/source_id filters — measure the
  query plan; the array is small (few teams). Mirror the `source_id`/`domain`
  denormalization precedent.
- **Storage growth:** the union can exceed any single team's needs (an
  everything team stores everything). Accepted per the goal; surface the cost.
- **Migration correctness:** `visible_team_ids = {}` means invisible — the
  backfill (U7) must complete (or the predicate must fall back) before the U4
  filter is enforced, or retrieval silently empties. Gate behind a flag and
  verify golden-question parity.
- **Multi-team meeting semantics:** effective view = union of attendees' teams
  (most permissive). Confirm this is desired vs intersection (Open decisions).

## Open decisions (resolve in execution)

- **Union vs intersection** for a meeting whose attendees span teams with
  different views of one source. Recommend **union** (matches effective-sources
  union; "what any of my teams can see").
- **Backfill vs full reindex** for U7 (`visible_team_ids` on existing corpus).
- Whether `sources.corpus_policy` is retired or repurposed as the org/source
  default that a team's `view_policy` inherits from.
- Migration flag/gating so U4's predicate only enforces after U7 stamping.
