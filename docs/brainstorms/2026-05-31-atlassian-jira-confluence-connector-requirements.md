---
date: 2026-05-31
topic: atlassian-jira-confluence-connector
status: ready-for-planning
---

# Atlassian (Jira + Confluence) Source Connector

## Problem Frame

Risezome now has a general source-connector foundation (the `sources.kind`
discriminator, per-kind indexers, connect flows, corpus indexing, and branded
surfacing) proven by GitHub and Trello. Many engineering teams run their planning
in **Jira** and their documentation in **Confluence** — both Atlassian Cloud
products. Their issues and pages hold exactly the "status, decisions, and docs"
context Risezome surfaces in meetings, and neither is connectable today.

Atlassian is the first connector to use **OAuth 2.0 3LO with refresh tokens** (a
real step up from Trello's static read token) and the first to put **two source
kinds behind one connection**. It both delivers two high-demand sources and
exercises the foundation against refresh-token auth — making the *next*
OAuth-based connector cheaper too.

Builds on: `docs/brainstorms/2026-05-31-trello-source-connector-requirements.md`
and its plan (the connector foundation).

---

## Actors

- **A1. Org admin / connector (setup):** authorizes the org's Atlassian account
  once, then selects which Jira projects and Confluence spaces to index.
- **A2. Meeting participant (consumption):** sees Jira issues and Confluence
  pages surface as cited context during a live meeting, same as any source.

---

## Key Flows

- **F1. Connect Atlassian (once) + pick resources**
  - **Trigger:** A1 connects Atlassian on the Sources page.
  - **Steps:** OAuth 2.0 3LO authorize (read scopes for Jira + Confluence) →
    Risezome stores the access + refresh token and the chosen Atlassian site →
    lists the account's Jira projects and Confluence spaces → A1 selects which to
    index → selected projects/spaces begin indexing.
  - **Outcome:** One Atlassian connection; chosen projects (Jira) and spaces
    (Confluence) registered as sources and queued.
  - **Covered by:** R1, R2, R5, R6, R7

- **F2. Index Atlassian content into the corpus**
  - **Trigger:** A resource is selected (and on manual re-index).
  - **Steps:** Using a valid (refreshed-if-needed) token, fetch each Jira
    project's issues (summary + description + comments) and each Confluence
    space's pages (title + body) → map each to a doc → chunk + embed into the
    existing corpus.
  - **Outcome:** Jira issues and Confluence pages are retrievable alongside
    GitHub/Trello content.
  - **Covered by:** R3, R4, R8, R9

- **F3. Surface Atlassian context in a meeting**
  - **Trigger:** Live retrieval matches a Jira- or Confluence-derived doc.
  - **Steps:** A card surfaces with `source: jira` (type `issue`) or
    `source: confluence` (type `page`), its title and a link back, citable in the
    answer.
  - **Outcome:** A2 sees grounded, linkable Atlassian context.
  - **Covered by:** R10, R11

---

## Requirements

**Connection (one per org, two products)**
- R1. A single **Atlassian connection** per org, obtained via **OAuth 2.0 3LO**
  with read scopes covering Jira and Confluence. Connecting once enables both
  products.
- R2. Store and **refresh** the token: access token + refresh token + expiry,
  refreshed on use so indexing keeps working past the access-token lifetime.
- R5. The connection records the chosen **Atlassian site** (cloud instance). v1
  supports a single site per org.

**Resource selection**
- R6. After connecting, A1 selects which **Jira projects** to index.
- R7. After connecting, A1 selects which **Confluence spaces** to index.
  Selecting Jira and Confluence resources is independent — a team may index only
  one product.

**Indexing**
- R3. Jira: per selected project, index each issue's **summary, description, and
  comments**, plus metadata (project, issue type, status, key, assignee, URL).
- R4. Confluence: per selected space, index each page's **title and body**, plus
  metadata (space, page title, URL). Page comments are **not** indexed in v1.
- R8. Both flow through the **existing corpus pipeline** (docs → chunk → embed),
  with the same source status/lifecycle as other connectors.
- R9. Freshness matches the other connectors: index **on connect + manual
  re-index** (full re-index). Live webhooks are deferred.

**Surfacing**
- R10. Jira issues surface as `source: jira`, type `issue`; Confluence pages as
  `source: confluence`, type `page`. Both are citable like any source, with a
  branded chip.
- R11. A surfaced card shows enough to orient and click through: the issue/page
  title and a link to it in Atlassian.

**Parity**
- R12. Atlassian sources appear in the Sources page with status (indexing / idle
  / errored) and a re-index affordance, consistent with GitHub repos and Trello
  boards. A revoked/expired-unrefreshable token surfaces a re-connect prompt.

---

## Success Criteria

- An org connects Atlassian once, picks Jira projects and/or Confluence spaces,
  and sees them reach an indexed state — no second authorization.
- During a meeting, a question answered by a Jira issue or a Confluence page
  surfaces that item as cited context, linking back to Atlassian.
- Indexing keeps working after the initial access token would have expired (the
  refresh path works unattended).
- Adding this connector reuses the foundation (the `kind` model, the corpus
  pipeline, the Sources UI pattern) without re-architecting it.

---

## Scope Boundaries

**In scope**
- One Atlassian OAuth connection (3LO + refresh) per org, single site.
- Two source kinds off it: Jira (projects → issues) and Confluence (spaces →
  pages), with independent resource selection.
- Indexers for issues (+comments) and pages (+body) into the corpus.
- Branded surfacing (`jira`/`confluence` chips, `issue`/`page` types) + Sources
  UI replacing any Jira "Coming soon" stub.

**Deferred for later**
- Live freshness via Atlassian webhooks.
- Incremental re-index (changed-since).
- Multiple Atlassian sites per org.
- Confluence page comments, attachments, and Jira JQL-scoped/filtered indexing.
- Per-member connections (one org-level connection, as with Trello).

**Outside this product's identity**
- Risezome reads Atlassian to ground meetings; it does not write back (no
  creating/transitioning issues, no editing pages).

---

## Dependencies / Assumptions

- **Builds on the connector foundation** from the Trello work (the `sources.kind`
  model, corpus pipeline, Inngest indexer pattern, Sources UI). That work is on
  an unmerged branch; this connector stacks on it.
- **Assumption (unverified against Atlassian's current API/terms):** Atlassian
  OAuth 2.0 3LO with read scopes for Jira + Confluence, the accessible-resources
  (cloud site) lookup, refresh-token rotation, the Jira issue-search + Confluence
  content APIs, and their rate limits behave as documented. Confirm during
  planning.
- **Assumption:** one Atlassian site per org is sufficient for the target teams;
  multi-site is deferred. Recorded as an explicit limit, not validated against a
  specific multi-site customer.
- **Assumption:** the target user is a team running planning in Jira and docs in
  Confluence — a roadmap-driven addition to multi-source grounding, not a single
  named account.

---

## Open Questions (for planning)

- The connection store: a new `atlassian_connections` table (access + refresh +
  expiry + cloud site) vs. generalizing the Trello connection table — Trello's
  static token has no refresh semantics, so likely new. Architectural; for plan.
- Where the refresh logic lives so both indexers (and any board picker fetch) get
  a valid token without racing on refresh.
- Confluence page `type`: a new `page` card type vs. reusing the existing `doc`
  type. (Brainstorm leans new `page`.)
- Jira content scope per project: all issues vs. open/recent only (volume can be
  large) — defaulted to all for v1; revisit if rate limits bite.
- Mapping the Atlassian content/comment shapes (Jira ADF description/comments,
  Confluence storage-format body) to clean indexable text.
