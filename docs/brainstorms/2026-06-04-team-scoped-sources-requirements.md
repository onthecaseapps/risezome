# Team-Scoped Sources with Shared, Deduplicated Indexing

**Created:** 2026-06-04
**Status:** Requirements (ready for `/ce-plan`)
**Topic:** Move sources from **org-scoped** to **team-scoped** selection, where a meeting's usable sources are the **union of its attendees' teams' sources** — while keeping the indexed corpus **deduplicated and indexed once per org** via a reference-counted team→source selection layer on top of the existing canonical corpus.

> **Companion to** the teams restructure (Org → Teams, multi-team membership). This doc covers **only** the sources/indexing dimension. Access elsewhere is settled separately: live meetings + captures are attendees-only; knowledge gaps are attendees-only with org-wide question assignment (assignee sees only the question, asker, and metrics). The old grant/share model and the 3-level privacy ladder are dropped and out of scope here.

---

## Problem Frame

Today sources are **org-scoped**: every indexed board/repo/project/space is visible to the whole org, and meeting retrieval searches the entire org corpus. With **teams** as the new membership unit (a user belongs to many teams), context should follow teams — a meeting should draw on the sources of the teams the people in the room belong to, not everything the org has ever connected.

The hard part is doing this **without duplicating indexing**. Multiple teams will include the same underlying board/repo, and the same content must not be embedded twice. The good news (from the current architecture): the corpus is **already deduplicated per org** — a board/repo/project/space is already exactly one `sources` row (`unique(org_id, external_id)`), indexed once into `docs` → `doc_chunks` → `corpus_chunk_embeddings`, all keyed by `(org_id, source_id)`. The "connection" (OAuth token) is already org-level and singular. So this is **not** a new dedup engine — it's a thin **selection + retrieval-scoping layer** over a corpus that already dedupes.

---

## Core Outcome

A team has a curated set of sources (boards, repos, Jira projects, Confluence spaces) chosen from the org's connected integrations. A meeting retrieves from the **union of the sources of every team its attendees belong to**. The same board added by two teams is **indexed once** and **referenced twice**; when the last team drops it, it is **de-indexed**. The per-org KMS/encryption boundary is unchanged — dedup is intra-org across teams; different orgs still index independently.

---

## Actors

- **A1 — Admin** (org-level `manager`/`super_admin`). Connects integrations for the org (one Trello/Atlassian OAuth, GitHub install), creates/manages teams, and **curates each team's source list** (adds/removes which boards/repos a team includes). Source curation is an admin power, consistent with team management.
- **A2 — Team member.** Belongs to one or more teams; **consumes** their teams' sources at meeting time. Does not curate source lists.
- **A3 — Meeting / bot.** Resolves its effective source set from the attendees' teams and retrieves only within it.
- **A4 — Indexer (background).** Indexes a source on first reference and de-indexes it when its reference count reaches zero.

---

## Requirements

### Structure & selection

- **R1.** **Connections stay org-level.** An admin connects each integration once for the org (the existing `trello_connections` / `atlassian_connections` / `github_installations` — one token holder per org, KMS-encrypted, unchanged). Teams do not bring their own OAuth.
- **R2.** **Sources are selected per team at portion grain** — a whole board, whole repo, whole Jira project, whole Confluence space (each already a `sources` row). No finer (intra-board / intra-repo) sub-selection in v1.
- **R3.** A **team→source selection** records which sources each team includes (a `team_sources` join keyed by `(team_id, source_id)`). A source may be selected by many teams; a team may select many sources. Both reference the **one** canonical `sources` row.
- **R4.** **Admins curate** a team's source list (add/remove). Members consume only. Any board/repo the org's connection can see is selectable by any team (the org is the trust boundary).

### Dedup, indexing & lifecycle

- **R5.** **One index per source, regardless of how many teams select it.** The canonical corpus (`sources`, `docs`, `doc_chunks`, `corpus_chunk_embeddings`) stays **org-level and is not denormalized with `team_id`.** Adding an already-indexed source to a second team is a **selection-row insert only** — zero re-indexing ("reference what exists").
- **R6.** **Reference-counted lifecycle.** A source's reference count = the number of teams selecting it.
  - First team to select a not-yet-indexed source → **trigger indexing** (the existing index pipeline, unchanged).
  - Subsequent selections of an already-indexed source → **no indexing**, just the join row.
  - Last team to deselect (refcount → 0) → **de-index: hard-delete** its `docs` (cascading to chunks + embeddings) and mark the `sources` row `removed`. The org-level connection/token remains, so a later re-add re-indexes from scratch.
- **R7.** **Delta/incremental indexing is unchanged** (content-hash reconcile, delta vs full). Team selection changes *whether* a source is indexed at all (refcount), not *how* an indexed source syncs.

### Retrieval

- **R8.** **A meeting's effective source set = the union of the sources selected by every team its (org-member) attendees belong to.** Retrieval is filtered to that set. Today retrieval is org-wide; this narrows it. (Implementation note for planning: the search RPCs gain a source-id filter; consider denormalizing `source_id` onto `doc_chunks`/embeddings to keep the vector/FTS filter off the join path.)
- **R9.** **No team sources → no corpus retrieval** for that meeting (it still runs; it just surfaces nothing from the corpus). Non-org-member guests contribute no teams and no sources.

### Boundary & migration

- **R10.** **Encryption/tenancy unchanged.** `org_id` remains on every source/corpus row and keys the per-org KMS envelope. Dedup happens **within one org across its teams** only; two different orgs that connect the same external workspace still index separately (their KMS keys differ — cross-org dedup is correctly impossible).
- **R11.** **Migration:** each existing org gets one **default team** seeded with **all** its current sources and **all** its members. Every existing `sources` row gets a `team_sources` row to that default team, so nothing de-indexes on cutover and current retrieval behavior is preserved until admins split sources across real teams. (Pre-release: the dev's 2 test orgs reshape freely.)

---

## Key Flows

- **F1 — Admin curates a team.** Admin opens a team, picks boards/repos/projects/spaces from the org's connected integrations; selections become that team's source set.
- **F2 — First selection indexes.** A team adds a board no team had → indexer runs, corpus populated once.
- **F3 — Second team shares, free.** Another team adds the same board → one join row, no re-index; both teams now retrieve it.
- **F4 — Last drop de-indexes.** Both teams remove the board → refcount 0 → docs/chunks/embeddings hard-deleted, source marked removed.
- **F5 — Meeting resolves union.** A meeting with attendees from Team A (`#platform-eng`: repo1, board1) and Team B (`#growth`: board1, board2) retrieves over `{repo1, board1, board2}` — `board1` once.
- **F6 — Re-add after de-index.** A team re-adds a previously de-indexed board → fresh index from the still-connected token.

---

## Acceptance Examples

- **AE1.** Board X selected by Team A and Team B has exactly **one** set of `docs`/`doc_chunks`/`corpus_chunk_embeddings`; adding it to Team B issues **no** indexing work. *(R5, R6)*
- **AE2.** A meeting whose attendees span Team A and Team B retrieves over the **union** of both teams' sources, with shared sources appearing once. *(R8, F5)*
- **AE3.** When the last team removes Board X, its corpus rows are hard-deleted and the source is `removed`; the org's Trello connection still exists. *(R6, F4)*
- **AE4.** A meeting whose attendees belong to teams with **no** sources surfaces nothing from the corpus and records gaps as usual; no cross-team leakage. *(R8, R9)*
- **AE5.** A non-admin member cannot add or remove a team's sources. *(R4)*
- **AE6.** After migration, every pre-existing source is selected by its org's default team and retrieval behaves exactly as before the change. *(R11)*

---

## Data-Model Sketch (directional — planning owns the final shape)

Canonical, **unchanged** (org-level, already deduped):

```
connection (org-level, 1 token):  trello_connections / atlassian_connections / github_installations
sources (org_id, source_id, kind, external_id, status, ...)        -- one row per board/repo/project/space
docs (org_id, source_id, ...) -> doc_chunks (org_id, doc_id, ...) -> corpus_chunk_embeddings (org_id, chunk_id)
```

**New** (the thin selection layer):

```
teams (org_id, team_id, name, slug, ...)            -- from the teams restructure
team_members (team_id, user_id)                     -- from the teams restructure
team_sources (team_id, source_id)                   -- NEW: which teams include which sources
   PK (team_id, source_id); FK source_id -> sources(source_id)
   refcount(source_id) = count(*) from team_sources where source_id = ?
```

**Retrieval filter** (the meatiest change): effective `source_ids` =
`select distinct ts.source_id from team_members tm join team_sources ts using (team_id) where tm.user_id = any(<attendee org-member ids>)`,
passed into `search_corpus_vector` / `search_corpus_fts` as a source-id filter. No `team_id` is added to the corpus tables.

---

## Scope Boundaries

### In scope (v1)
Team-level source selection at portion grain; the `team_sources` join; refcount-driven index-on-first-reference / hard-de-index-on-last-drop; admin-only curation; retrieval filtered to the union of attendees' teams' sources; org-level connections unchanged; migration to a per-org default team.

### Deferred to follow-up
- **Sub-portion selection** (Trello lists, repo paths, individual Confluence pages) — a finer indexing/refcount subsystem, only if teams need slices of the same board.
- **Self-serve (member) source curation** — admin-only for v1.
- **TTL/soft-orphan retention** for de-indexed sources — v1 hard-deletes immediately.
- **Per-team connections / per-team OAuth** — connections stay org-level.

### Outside this product's identity
- **Cross-org source dedup or sharing** — forbidden by the per-org KMS boundary; each org indexes independently.
- **External/anonymous source access** — all source access stays within org membership.

---

## Open Questions (for planning)

- **Q1 — Retrieval filter mechanics.** Whether to denormalize `source_id` onto `doc_chunks` + `corpus_chunk_embeddings` (fast filter, small migration + indexer change) vs. filtering through a `docs` join in the search RPCs (no schema change, join in the hot path). A planning/perf decision; default leans denormalize for the HNSW/FTS path.
- **Q2 — De-index trigger timing.** Is refcount→0 de-indexing synchronous with the last deselect, or a background sweep (safer against rapid re-add churn)? Default: background, idempotent, with a short grace check so an immediate re-add doesn't thrash.
- **Q3 — GitHub repo selection grain.** A GitHub *installation* is org-wide and can expose many repos; confirm a team selects individual repos (each its own `sources` row), matching Trello boards — assumed yes.

---

## Dependencies & Assumptions

- **D1 — Depends on the teams restructure** (`teams` + `team_members` tables, multi-team membership). This doc adds `team_sources` and the retrieval filter on top.
- **D2 — Builds on the existing canonical corpus** (`sources` unique constraints + `docs.content_hash` reconcile) — no change to how an indexed source syncs.
- **D3 — KMS unchanged** — `org_id` stays the encryption + tenancy key on all source/corpus rows; the selection layer adds no crypto.
- **D4 — Existing index/de-index pipeline reused** — first-reference indexing fires the current `*.index-requested` events; de-index reuses the existing doc/chunk/embedding cascade-delete.
