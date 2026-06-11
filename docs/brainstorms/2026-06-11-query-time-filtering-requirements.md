# Query-Time Corpus Filtering — Requirements

**Date:** 2026-06-11
**Status:** Brainstorm → ready for planning
**Tier:** Deep (feature)

## Problem

Corpus filtering today is **index-time and per-source**. A source's
`corpus_policy` (column on `sources`, resolved org-default → per-source override
in `apps/portal/src/inngest/lib/corpus-policy.ts`) is applied during indexing
(`index-repo.ts:216` / `connector-index.ts:142`): excluded files/entities are
pruned, so the **physical corpus contains only what the policy kept**.

But the corpus is **org-level and shared** — a repo is one `sources` row per
installation, indexed once, referenced by many teams via `team_sources` (the
canonical corpus is deliberately *not* denormalized per team). So filtering and
sharing collide:

> Team A wants **Code-only** on `acme/web`; Team B wants **Everything** on the
> same repo. Both point at the same `sources` row and the same physical corpus.
> The filter editor writes the single `sources.corpus_policy`, so **last save
> wins** — the corpus is re-indexed to that one policy and *both* teams get that
> result. The card even shows the other team's setting, because the pill reads
> the shared source's policy. There is no way to have the repo simultaneously
> code-only-for-A and everything-for-B.

Filtering is per-source; selection and the new enable/disable pause
(`team_sources.enabled`) are per-team. The mismatch means teams that share a
source must also share its filter.

## Goal

Let each team see its **own filtered view** of a shared source, while the system
**stores the minimal amount of data from that source that satisfies all teams**
— never indexing a repo twice, never storing content no team wants, and never
showing a team content its own policy excludes.

The guiding invariant: **store the union, retrieve the per-team subset.** A
document is stored iff at least one referencing team would keep it; at query
time a team sees only the documents its policy admits.

## Users

- **Primary — workspace admin/manager** setting a per-team view policy on a
  shared source (same `requireAdmin`/`requireManager` gating as today's filter
  editor). They want Team A's meetings to retrieve code while Team B's retrieve
  everything, from one indexed copy.
- **Secondary — every meeting participant**, transparently: retrieval returns
  only what their team(s) are allowed to see, with no per-meeting configuration.

## Requirements

### R1 — Two policy layers: storage vs view
Split today's single policy into:
- **View policy (per team, per source):** what a team is allowed to *retrieve*.
  This is what the filter editor edits going forward.
- **Storage policy (per source, system-derived):** what is physically *indexed*.
  Not directly edited — it is computed as the **union** of all referencing
  teams' view policies (R2).

### R2 — Storage is the minimal union
A document/chunk is stored iff **≥1 team** referencing the source would keep it
under its view policy. Equivalently: drop a document only when **no** team wants
it. This is the minimal-data invariant — the corpus is the least set that can
satisfy every team's view, and the repo is still indexed exactly once.

### R3 — Per-team filtering at query time
Retrieval narrows the shared superset to the requesting context's view policy.
A meeting draws sources from its attendees' teams (`meeting_effective_source_ids`
already unions `team_sources` across attendee teams); the **effective view per
source = the union of the attending teams' view policies** for that source
(most-permissive among the attendees present — consistent with how effective
*sources* already union). A team never retrieves a document its view excludes.

### R4 — Query-time filtering must be cheap and indexable
Per-query glob evaluation over the whole corpus is not viable. The central design
choice (Open Questions) is how view policies become a fast retrieval predicate.
Two candidate shapes, to be decided in planning:
- **(a) Precomputed per-doc visibility bitmap.** At index time (where globs are
  cheap), evaluate each doc against the small set of *distinct* view policies
  referencing the source and store a bitmap of "which policies admit this doc."
  Storage = bitmap non-zero (R2); query = the team's policy bit is set; a
  multi-team meeting = a bitmap intersection. Keeps full glob expressiveness;
  cost is recomputing bitmaps when a policy or team set changes (R5).
- **(b) Indexed category/attribute columns.** Tag each doc at index time with a
  small set of query-evaluable dimensions (e.g. `doc_kind` ∈ code/docs/config/
  data/test, path-prefix, connector attrs: jira status, age, archived) and
  translate a view policy into a SQL predicate over those columns. Simpler and
  policy-version-independent, but constrains view policies to those dimensions
  (arbitrary mid-path globs become storage-time-only, not per-team view).

The search RPCs (`search_corpus_vector`, `search_corpus_fts`, both already
source-scoped) gain the chosen predicate; over-fetch-then-app-filter is a
fallback but risks dropping top-k, so push the filter into the RPC.

### R5 — Reconcile on any change to the union
Adding/removing a team's reference, editing a view policy, or a team
selecting/deselecting the source recomputes the storage union and reconciles at
**document granularity**: index newly-needed docs, prune docs no team wants
anymore, refresh per-doc visibility (R4a) or attributes (R4b). This generalizes
today's per-*source* refcount lifecycle (last team → de-index whole source) to
per-*document* ("last policy that wanted this doc → drop the doc"). Reuses the
existing reconcile path; no whole-repo re-index for a single team's policy edit.

### R6 — Safe, visible, no regression
- **Fail safe:** if a view policy can't be evaluated for a candidate, exclude it
  (never leak content a team's policy would drop).
- **Exclusion visibility, per team:** a team's Sources card shows "you retrieve
  N of M documents in this source" so a narrower policy is never silent.
- **No material latency regression** on the live retrieval path (the predicate
  must be index-friendly; measure against the latency budget).
- **Index-once preserved:** the change must not reintroduce per-team corpora or
  duplicate indexing.

### R7 — Admin-gated view editing; storage is derived
Only admins/managers edit a team's view policy. The storage policy is
system-computed from the set of view policies and is never edited directly —
preventing a hand-edited storage policy from starving a team's view.

## Scope boundaries

**In v1:**
- Per-team view policy on shared sources (the filter editor edits *views*).
- System-derived storage = union; document-granular reconcile on change.
- Query-time filtering pushed into the search RPCs.
- Per-team exclusion visibility.

**Deferred (designed-for, not built):**
- Per-*user* views (only per-team in v1).
- Content-heuristic visibility (model-scored, not policy-driven).
- Cross-team policy negotiation/notification UI ("Team B's Everything is forcing
  full storage of this repo") beyond a simple storage-cost indicator.

**Outside this feature's identity:**
- Not a per-file manual curation UI — still glob/preset/attribute *policy*.
- Not a change to the dedup/refcount fundamentals (index-once stays).
- Not the enable/disable **pause** (`team_sources.enabled`) — pause hides a whole
  source from a team's retrieval; view policy filters *content within* a source.
  They compose (a paused source contributes nothing regardless of view).

## Success criteria

- **The motivating case works:** Team A (Code-only) + Team B (Everything) on
  `acme/web` → the repo is indexed **once**, the corpus stores **everything**
  (the union), Team A's meetings retrieve only code, Team B's retrieve all.
- **Minimal storage:** if *all* referencing teams are Code-only, the docs/prose
  are **not** stored (pruned); adding one Everything team backfills them via
  reconcile, not a full re-index.
- **No leakage:** a team never retrieves a document its view policy excludes
  (assert in a retrieval test with two policies over one corpus).
- **Latency:** the per-query filter stays within the live-pipeline latency
  budget (measure; target negligible added p50).
- **Change is incremental:** editing one team's view reconciles only the
  affected documents, with no whole-source re-index when another team still
  needs them.

## Dependencies / Assumptions

- The search RPCs can carry an extra predicate (a policy-bit test or
  category/attribute filter) without losing index usage on the vector/FTS path —
  confirm the query plan in planning.
- `doc_chunks` / `docs` rows can carry the visibility metadata (bitmap column or
  category/attribute columns); the indexer already has the path + connector
  attributes needed to compute them (the corpus-filtering policy work fetches
  status/archived/age — see `2026-06-10-corpus-filtering-policy-requirements.md`).
- The existing reconcile (`corpus-reconcile.ts`) can operate at document
  granularity keyed on visibility, not just whole-source presence.
- Per-team view policy needs a home: `team_sources.view_policy` (jsonb/preset)
  vs a new `team_source_policy` table — decide in planning. Today's
  `sources.corpus_policy` likely becomes a team's *default* view (backfill).

## Open questions for planning

- **R4 mechanism:** per-doc visibility **bitmap** (full glob expressiveness,
  recompute-on-policy-change) vs **category/attribute columns** (simpler,
  policy-version-free, limited expressiveness) vs a hybrid (attributes in
  columns for connectors, bitmap for repo path globs). This is the load-bearing
  decision.
- **Bitmap identity & churn:** how a "distinct view policy" is keyed (content
  hash of the resolved policy) and how many distinct policies a source realistically
  sees (bounds the bitmap width); what triggers a bitmap recompute and how to do
  it incrementally.
- **Multi-team meeting semantics:** confirm effective view = **union** of the
  attendees' teams (most permissive) vs intersection (least permissive). Union
  matches today's effective-*sources* union and "what any of my teams can see";
  intersection is stricter but may hide content an attendee legitimately has.
- **Storage representation:** materialize the union on `sources` (a derived
  storage policy) vs compute it on the fly from `team_sources` at index time.
- **Cost guard:** a single Everything team forces full storage of a large repo —
  acceptable per the goal, but surface the storage cost and consider a soft cap
  / admin warning.
- **Migration:** today's per-source `corpus_policy` → becomes the org/team
  default view; backfill existing sources' storage as the union of current
  selections; ensure no team's retrieval changes on cutover.
- **Interaction with refcount + pause:** document-granular pruning must compose
  with the source-level refcount purge (last team removes the source → whole
  source de-indexed) and the `enabled` pause (no retrieval at all).
