---
date: 2026-05-31
topic: trello-source-connector
status: ready-for-planning
---

# Trello Source Connector (+ general connector foundation)

## Problem Frame

Risezome grounds live meetings in a team's own tools by indexing connected
sources and surfacing them as cited context cards. Today **only GitHub is
actually wired up**: the `sources` table requires a foreign key to
`github_installations` (`supabase/migrations/...sources...`), the indexer
(`apps/portal/src/inngest/functions/index-repo.ts`) is GitHub-specific, and the
Sources page (`apps/portal/app/(authed)/sources/page.tsx`) renders Jira and
Slack as **"Coming soon" stubs** with no ingestion behind them.

The retrieval layer underneath is already source-agnostic — `docs` +
`corpus_chunk_embeddings` (pgvector), the chunker, and the embedder all take
text regardless of origin. The missing piece is a **general way to register and
index a non-GitHub source**. Adding Trello forces that general connector model
into existence; Trello is the first instance built on it, and it makes the next
connectors (Jira, Slack, …) substantially cheaper.

Teams that run their planning and standups out of Trello can't currently get any
of that board context surfaced in-meeting. This closes that gap and proves the
multi-source foundation in one move.

---

## Actors

- **A1. Org admin / connector (setup):** connects the org's Trello account and
  selects which boards Risezome should index. Same person managing GitHub today.
- **A2. Meeting participant (consumption):** sees Trello cards surface as cited
  context during a live meeting, identical in shape to GitHub-sourced cards.

---

## Key Flows

- **F1. Connect Trello + pick boards**
  - **Trigger:** A1 opens the Sources page and connects Trello (replacing the
    current "Coming soon" stub).
  - **Steps:** Authorize the org's Trello account (org-level token) → Risezome
    lists the boards that account can see → A1 selects which boards to index →
    selected boards begin indexing.
  - **Outcome:** Chosen Trello boards are registered as sources and queued for
    indexing.
  - **Covered by:** R1, R2, R5, R6

- **F2. Index Trello content into the corpus**
  - **Trigger:** A board is selected (and on manual re-index).
  - **Steps:** Fetch each card on the board — name, description, and comment
    thread — plus metadata (board, list/status, labels, due, members) → map each
    card to a doc → chunk + embed into the existing corpus.
  - **Outcome:** Trello cards are retrievable alongside GitHub content.
  - **Covered by:** R3, R4, R7, R8

- **F3. Surface Trello context in a meeting**
  - **Trigger:** Live meeting retrieval matches a Trello-derived doc.
  - **Steps:** A card surfaces with `source: trello`, showing the card name,
    board · list, and a link back to the Trello card; citable in the AI summary.
  - **Outcome:** A2 sees Trello context grounded and linkable, same as any other
    source.
  - **Covered by:** R9, R10

---

## Requirements

**General connector foundation**
- R1. A source must be representable **without** a GitHub installation — the
  source model can no longer require every source to be a `github_installations`
  row. Trello sources are first-class.
- R2. Source registration carries a **source type** (e.g. `github`, `trello`)
  and the per-type connection/identity it needs, so additional connectors slot
  in without re-architecting.

**Trello connection**
- R5. A team connects **one org-level Trello account** (per-user token auth, but
  used at the org level — Trello has no org-app install equivalent to GitHub).
- R6. After connecting, A1 **selects which boards** to index from the boards that
  account can access (mirrors GitHub's install + repo-select). Personal/unrelated
  boards are not indexed unless chosen.

**Trello indexing**
- R3. Index, per selected board, each card's **name, description, and comments**,
  plus metadata: board, list/status, labels, due date, members.
- R4. Trello content flows through the **existing corpus pipeline** (docs →
  chunk → embed → `corpus_chunk_embeddings`); no separate retrieval path.
- R7. **Archived/closed cards and archived lists are skipped.** Checklists are
  **not** indexed in this version.
- R8. Freshness matches GitHub today: index **on connect + on manual re-index**.
  Live Trello webhook updates are deferred.

**Surfacing**
- R9. Trello-derived context surfaces as a card with `source: trello` (the
  source-chip color already exists in the palette) and a meaningful type/label
  (e.g. a Trello card). It is citable in the synthesized answer like any source.
- R10. A surfaced Trello card shows enough to orient and click through: card
  name, board · list, and a link to the card in Trello.

**Parity**
- R11. Trello sources appear in the Sources page list with status (indexing /
  idle / errored) and a re-index affordance, consistent with how GitHub repos
  are shown today.

---

## Success Criteria

- An org can connect Trello, pick boards, and see those boards reach an indexed
  state on the Sources page — no GitHub install involved anywhere in the path.
- During a meeting, a question whose answer lives in a Trello card surfaces that
  card as cited context, linking back to Trello.
- Adding the *next* connector (Jira or Slack) reuses the foundation from R1/R2
  and does not require touching the source model again.
- Indexing a connected board does not pull in archived cards or unrelated
  personal boards.

---

## Scope Boundaries

**In scope**
- General source model that supports non-GitHub sources (R1, R2).
- Trello connector end to end: connect → pick boards → index cards+comments →
  surface as cited cards (F1–F3).
- Sources-page Trello UI replacing the "Coming soon" stub.

**Deferred for later**
- Jira and Slack connectors (the foundation makes them cheaper; they remain
  stubs for now).
- Live freshness via Trello webhooks (per-board webhook registration + handling).
- Per-member Trello connections / union-of-visible-boards coverage.
- Indexing checklists, attachments, and archived content.

**Outside this product's identity**
- Risezome reads Trello to ground meetings; it does not write back to Trello,
  move cards, or act as a Trello client. (Writing gaps back into tools is a
  separate, existing product thread and not part of this connector.)

---

## Dependencies / Assumptions

- **Assumption:** the target user is a team that runs planning/standups out of
  Trello — a roadmap-driven addition to the multi-source grounding strategy
  rather than a single named customer. Recorded as the motivating segment, not
  validated against a specific account.
- **Assumption:** Trello's API exposes boards, cards, descriptions, comments, and
  metadata under an org-level user token sufficient for read indexing.
  **Unverified against Trello's current API/auth terms** — confirm during
  planning (auth flow, token scope, rate limits).
- **Dependency:** reuses the existing corpus pipeline (`docs`,
  `corpus_chunk_embeddings`, `@risezome/engine` chunker + Voyage embedder) and
  the Inngest indexing pattern (`index-repo.ts` as the GitHub analog).
- **Verified:** only GitHub is currently implemented; Jira/Slack are
  "Coming soon" stubs; the `sources` table is GitHub-coupled. This drives R1/R2.

---

## Open Questions (for planning)

- Exact shape of the generalized source model (how `github_installations`
  decouples from `sources`; where Trello identity/token lives) — architectural,
  for ce-plan.
- Trello auth specifics: token acquisition flow, scope, storage, and rate-limit
  handling against the Trello REST API.
- How a Trello "card" maps onto the `docs.type` vocabulary (`file` / `issue` /
  `pr` today) and the in-meeting card `type`/glyph.
- Re-index cadence beyond manual (any scheduled refresh?) — defaulted to
  on-connect + manual for now.
- Whether board selection state and per-board indexing status reuse the existing
  `sources` status machine or need additions.
