---
title: "feat: Sources page redesign — per-team configuration with multi-connection cards"
type: feat
status: active
date: 2026-06-05
---

# feat: Sources page redesign — per-team configuration with multi-connection cards

## Summary

Rework the Sources page (`/sources`) into the **per-team source editor** from the mockup: pick a team to configure (top-right "Configuring {team}"), then each **connection** renders as a card — **GitHub once per connected org** (fixing the current `installRows[0]` bug that hides additional installations), plus the single Jira, Confluence, and Trello connections. Each card expands to an **All / Selected** checklist of its repos / projects / spaces / boards; checking an item adds it to the selected team's sources (driving the already-shipped `team_sources` refcount index/de-index lifecycle), unchecking removes it. An **"Add a source"** section offers "Add another GitHub org" (real) and "Connect Slack" (disabled stub), with a footer note explaining GitHub = multiple orgs, the rest = one workspace each.

The backend largely exists (the teams restructure shipped `team_sources` + `addSourceToTeam`/`removeSourceFromTeam`; the connect/select actions create source rows). This is primarily the page UI + wiring item-selection to the per-team lifecycle, plus making the Teams & members team-detail's source list read-only so there's a single source-of-truth editor. Branch from `main`.

---

## Problem Frame

Today `/sources` is an **org-level** connection + indexing manager that renders only the **first** GitHub installation (`installRows[0]`), so a second connected GitHub org is stored and indexable but invisible. Separately, the teams restructure introduced **team-scoped sources** (`team_sources` + a refcount index/de-index lifecycle) but the only editor is a basic toggle list inside the Teams & members team-detail. The mockup unifies these: the Sources page becomes the rich **per-team** source editor across **all** connections (every GitHub org, Jira, Confluence, Trello), and the team-detail becomes a read-only summary that links here.

---

## Requirements Traceability

Origin: the user's Sources mockup + four confirmed decisions (this session).

| Requirement | Unit |
| --- | --- |
| Page is per-team: a "Configuring {team}" selector scopes all selection to one team | U1 |
| Each connection is a card; **GitHub renders one card per installation** (fix `installRows[0]`) | U2 |
| Card expands to All/Selected checklist (filter, counts, indexing progress) of repos/projects/spaces/boards | U3 |
| Checking an item = add to the team's sources (refcount index-on-first-ref); unchecking = remove (de-index on last drop) | U4 |
| "Add a source": "Add another GitHub org" (real), "Connect Slack" (disabled stub), footer note | U5 |
| Teams & members team-detail Sources card → read-only summary linking to Sources | U6 |
| GitHub multi-org only; Jira/Trello/Confluence stay single-connection (no schema change) | U2, U4 |

---

## Key Technical Decisions

**KTD1 — The page is team-scoped via a `?team=` selection, not the browse-lens cookie.** Configuring a team's sources is a deliberate admin action distinct from the `CURRENT_TEAM_COOKIE` browse lens. The selected config-team comes from a `?team=<teamId>` search param (default: the org's first team), so the choice is explicit, shareable, and decoupled from browsing. The page stays `requireAdmin`-gated.

**KTD2 — Selection drives the shipped `team_sources` refcount lifecycle.** Checking an item calls `addSourceToTeam({orgId, teamId, sourceId})`; unchecking calls `removeSourceFromTeam(...)` (`app/_lib/team-source-lifecycle.ts`). Indexing follows: first team to add a source indexes it; last team to drop it de-indexes (via the purge cron). No new indexing logic.

**KTD3 — "Ensure source exists" differs by provider (the one real seam).** A checklist item maps to a `sources` row that may or may not exist yet:
- **GitHub**: the install-callback already creates a `sources` row per *granted* repo (`upsert on (installation_id, repo_full_name)`), so every repo in the list already has a `source.id` — checking is **just `addSourceToTeam`**.
- **Trello / Jira / Confluence**: a board/project/space becomes a `sources` row only when selected (the existing `trello-select-action` / `atlassian-select-action` upsert by `(org_id, external_id)`). So checking an unselected item must **ensure the source row exists** (mirroring those actions) *then* `addSourceToTeam`.
The per-team toggle action wraps this provider-specific ensure-source step + the team lifecycle call.

**KTD4 — GitHub multi-installation is UI-only.** `github_installations` is already one-to-many (no `unique(org_id)`); the fix is rendering every non-removed installation as its own card instead of `installRows[0]`. Trello/Atlassian stay single (`unique(org_id)` kept) per the confirmed scope — no schema change in this plan.

**KTD5 — Single editor.** After this, the Sources page is the only place that *edits* `team_sources`. The Teams & members team-detail Sources card becomes read-only (count + "manage on Sources") to avoid two editors for the same data (U6).

**KTD6 — Slack is a disabled stub.** The "Connect Slack" affordance renders disabled/"coming soon" — no Slack ingestion is built; it matches the mockup without implying a real integration.

---

## High-Level Technical Design

### Page shape (per the mockup)

```text
Sources                                   [ Configuring · {team ▾} ]   (?team=)
"…configured per team — pick whole accounts or specific repos/boards/projects."

CONNECTED · {N} SEARCHED BY {TEAM}
┌ GitHub  (acme)   • Connected   Indexing 1638/2096      [⏻ master] [⋮] [▲]
│   [All repositories | Selected]   3 of 12 selected     🔍 filter
│   ☑ acme/web-app            240 files
│   ☑ acme/api-gateway        812/1,270  ▓▓▓░  (indexing progress)
│   ☐ acme/mobile
└ …
┌ GitHub  (acme-labs) • Connected  653 indexed            [⏻] [⋮] [▼]   (collapsed)
┌ Jira  • Connected  acme.atlassian.net · 653 issues      [⏻] [⋮] [▲]
│   [All projects | Selected]  2 of 6   🔍 filter   ☑ Platform (PLAT) …
┌ Trello • Connected  Acme workspace · 1,172 cards        [⏻] [⋮] [▼]

ADD A SOURCE
  GitHub   Connect another GitHub org…        [+ Add another org]
  Slack    Link your Slack workspace…         [+ Connect Slack]  (disabled)

ⓘ GitHub supports multiple org connections… Jira, Trello and Slack connect one workspace each.
```

### Item-toggle flow (KTD2/KTD3)

```text
check item (repo/project/space/board) for the selected team
   │
   ├─ GitHub  → source row already exists → addSourceToTeam(team, source.id)
   └─ Trello/Jira/Confluence → ensure source row by (org_id, external_id)
                              → addSourceToTeam(team, source.id)
uncheck → removeSourceFromTeam(team, source.id)   (refcount → 0 ⇒ de-index)
```

---

## Implementation Units

### U1. Team-scoped Sources page shell + config-team selector

**Goal:** Turn `/sources` into a per-team editor: a "Configuring {team}" selector (top-right) backed by `?team=`, and resolve the selected team + its current `team_sources` for the rest of the page.

**Requirements:** Page-is-per-team; KTD1.

**Dependencies:** none.

**Files:**
- `apps/portal/app/(authed)/sources/page.tsx` (modify — header + subtitle copy, the team selector, resolve `?team=` → teamId, load the org's teams + the selected team's `team_sources` set)
- `apps/portal/app/(authed)/sources/_config-team-selector.tsx` (create — client dropdown that sets `?team=` and navigates)
- `apps/portal/test/sources/config-team-selector.test.tsx` (create)

**Approach:**
- `requireAdmin` (unchanged). Load `listUserTeams(orgId)` (or all org teams — admins configure any team; prefer all non-archived org teams). Resolve `selectedTeamId` from `?team=`, validated against the org's teams; default to the first team.
- Load the selected team's `team_sources` (the set of `source_id`s) once — passed down so each connection card knows which items are checked.
- Header copy from the mockup; the selector mirrors the team-switcher dropdown styling.

**Test scenarios:**
- `?team=<valid>` selects that team; `?team=<foreign/absent>` falls back to the first team.
- Selector lists the org's non-archived teams; choosing one navigates with the new `?team=`.
- Test expectation: render + navigation; the data load is covered by the page integration in U3/U4.

**Verification:** the page renders scoped to a chosen team; switching teams re-scopes the checked state.

---

### U2. Connection cards — all GitHub installations + Jira/Confluence/Trello

**Goal:** Render every connection as a card (GitHub **once per installation**, fixing `installRows[0]`; plus the single Jira/Confluence/Trello), each with status, indexed counts, a master toggle, a kebab, and expand/collapse.

**Requirements:** Each-connection-is-a-card; GitHub-multi-org; KTD4.

**Dependencies:** U1.

**Files:**
- `apps/portal/app/(authed)/sources/page.tsx` (modify — fetch ALL `github_installations` (drop the `[0]`); per installation fetch its repos; keep the single Trello/Atlassian reads)
- `apps/portal/app/(authed)/sources/_connection-card.tsx` (create — the card chrome: icon, name + account badge, connected/indexed status, master toggle, kebab, expand)
- `apps/portal/app/(authed)/sources/_connection-sources.tsx` (modify/refactor — the existing expand body, now embedded in the card)
- `apps/portal/test/sources/connection-card.test.tsx` (create)

**Approach:**
- GitHub: loop `installRows` (all, `removed_at is null`); for each, its repos (sources by `installation_id`) + available repos from the GitHub App (the install grants the repo set). Render one card per installation with its `account_login` badge ("acme", "acme-labs").
- Jira/Confluence/Trello: one card each (the `.maybeSingle()` connection), unchanged in cardinality.
- Master toggle (per card): bulk add/remove all of this connection's items for the selected team (a convenience over the per-item checks); kebab carries reindex/manage/disconnect (reuse existing actions).
- Mirror the mockup's status line ("Indexing X/Y files", "N files indexed", "N issues indexed", "N cards indexed").

**Test scenarios:**
- Two GitHub installations → two GitHub cards, each with its `account_login`; a single installation → one card (no regression).
- A suspended installation still renders its card with the suspended state.
- Jira/Confluence/Trello each render exactly one card when connected; absent when not.
- Master toggle reflects "all items selected for this team" vs partial/none.

**Verification:** every connected org/workspace appears as its own card; a 2nd GitHub org is now visible.

---

### U3. Per-item checklist — All/Selected tabs, filter, counts, progress

**Goal:** Inside each expanded card, a checklist of items (repos/projects/spaces/boards) with an All/Selected tab, a filter box, per-item counts + indexing progress, and a checkbox reflecting membership in the selected team's sources.

**Requirements:** Card-expands-to-checklist.

**Dependencies:** U1, U2.

**Files:**
- `apps/portal/app/(authed)/sources/_source-item-list.tsx` (create — provider-agnostic checklist: All|Selected tabs, filter, item rows with checkbox + count + optional progress; reuses the team_sources set from U1)
- `apps/portal/app/(authed)/sources/_github-repo-item.tsx` (modify — fold into the shared item row or feed it)
- `apps/portal/test/sources/source-item-list.test.tsx` (create)

**Approach:**
- Each provider supplies a normalized item list: `{ id (external/source id), label, count, indexed?, progress?, sourceId|null, checked }`. The shared component renders tabs/filter/rows; the checkbox's checked state = item's `sourceId ∈ team_sources`.
- "All" lists every available item (granted repos / boards / projects / spaces, indexed or not); "Selected" filters to checked.
- Counts: GitHub `indexed_files`/`total_files` (+ progress bar when indexing); Trello cards, Jira/Confluence issues/pages where available.

**Test scenarios:**
- Filter narrows the visible rows by label substring.
- "Selected" tab shows only checked items; the "N of M selected" count is correct.
- An indexing item shows a progress bar; an idle item shows its file/issue count.
- A checkbox is checked iff the item's source is in the selected team's `team_sources`.

**Verification:** each connection's items render with correct checked state for the selected team.

---

### U4. Item-toggle action — ensure-source + team lifecycle (per provider)

**Goal:** Wire the checklist checkbox to the shipped team-source lifecycle, with the provider-specific ensure-source step.

**Requirements:** Check=add (index-on-ref); uncheck=remove (de-index); KTD2, KTD3.

**Dependencies:** U3.

**Files:**
- `apps/portal/app/(authed)/sources/team-source-toggle-action.ts` (create — `setItemForTeam({teamId, provider, identity, on})`: ensure the `sources` row, then `addSourceToTeam`/`removeSourceFromTeam`; `requireAdmin` + org scope; revalidate `/sources`)
- `apps/portal/app/(authed)/sources/trello-select-action.ts`, `atlassian-select-action.ts` (modify/reuse — extract the ensure-source upsert so the toggle action can call it)
- `apps/portal/app/_lib/team-source-lifecycle.ts` (reuse — unchanged)
- `apps/portal/test/sources/team-source-toggle.test.ts` (create)

**Approach:**
- GitHub on: the `sources` row exists (created at install) → resolve `source.id` by `(installation_id, repo_full_name)` → `addSourceToTeam`.
- Trello/Jira/Confluence on: ensure the `sources` row by `(org_id, external_id[, kind])` exactly as the existing select actions do (upsert), then `addSourceToTeam`.
- Off (any provider): resolve `source.id` and `removeSourceFromTeam` (refcount → 0 de-indexes via the purge cron). Do NOT hard-delete the `sources` row here; the lifecycle owns de-index.
- Master toggle (U2) = batch of these for all of a connection's items.

**Execution note:** Characterize the existing trello/atlassian select-action ensure-source upsert before extracting it, so the toggle path provably matches today's source-creation.

**Test scenarios:**
- GitHub check → `addSourceToTeam` with the existing repo source id; no new source row created.
- Trello/Jira/Confluence check on an unselected item → a source row is ensured (upsert by external_id) AND `addSourceToTeam` fires.
- Uncheck → `removeSourceFromTeam`; the source row is NOT deleted by the action (purge cron owns de-index).
- Toggling on an item already in the team is idempotent (no duplicate team_sources row).
- A non-admin cannot toggle (action rejects).

**Verification:** checking/unchecking moves items in/out of the team's sources and triggers the refcount index/de-index; GitHub creates no redundant source rows.

---

### U5. "Add a source" section — add-another-GitHub-org + Slack stub + footer

**Goal:** The bottom "Add a source" block: "Add another GitHub org" (initiates a second install), a disabled "Connect Slack" stub, and the explanatory footer.

**Requirements:** Add-a-source affordances; KTD6.

**Dependencies:** U2.

**Files:**
- `apps/portal/app/(authed)/sources/_add-source.tsx` (create)
- `apps/portal/app/(authed)/sources/page.tsx` (modify — render the section + footer)

**Approach:**
- "Add another GitHub org" → the existing install initiation (`/sources/install`), which mints a per-org state token and 302s to GitHub. Re-installing on another GitHub org just creates another `github_installations` row (KTD4) — no new backend.
- "Connect Slack" renders disabled with a "coming soon" affordance (no action).
- Footer note verbatim-ish from the mockup (GitHub multi-org; others one workspace each).

**Test scenarios:**
- "Add another GitHub org" links to the install initiation route.
- "Connect Slack" is disabled / non-interactive.
- Test expectation: render-level; the install route itself is unchanged.

**Verification:** an admin can start a second GitHub org connection from the page; Slack shows as future.

---

### U6. Teams & members team-detail Sources → read-only summary

**Goal:** Make the team-detail's Sources card read-only (count + "manage on the Sources page"), since the Sources page is now the editor (KTD5).

**Requirements:** Single editor; KTD5.

**Dependencies:** U4 (the Sources page is the editor).

**Files:**
- `apps/portal/app/(authed)/teams/_components/team-detail.tsx` (modify — replace the editable `SourcePicker` with a read-only count + a link to `/sources?team=<teamId>`)
- `apps/portal/app/(authed)/teams/_components/source-picker.tsx` (delete or demote — no longer the editor; remove if unused)
- `apps/portal/test/teams/teams-members-client.test.tsx` (modify — the team-detail no longer edits sources)

**Approach:**
- The team-detail Sources card shows "{n} sources" + "Manage on the Sources page" → `/sources?team=<teamId>`. No toggles.
- If `source-picker.tsx` is now unused, delete it (and prune its test) — but verify nothing else imports it first (the earlier unified-teams work left some type-only imports; check before deleting).

**Test scenarios:**
- The team-detail renders a read-only source count + a link to `/sources?team=…`; no source toggle controls are present.

**Verification:** team-detail no longer edits `team_sources`; the link routes to the per-team Sources view.

---

## Scope Boundaries

### In scope
The Sources page redesign as a per-team editor; rendering all GitHub installations; the per-item checklist driving `team_sources`; the add-another-GitHub-org + Slack-stub affordances; making the team-detail Sources read-only.

### Deferred to Follow-Up Work
- **Trello / Atlassian multi-connection** (drop `unique(org_id)`, multi-connect OAuth) — deferred until a real multi-site/multi-account customer appears (confirmed this session).
- **Real Slack ingestion** — the stub is a placeholder only.
- **Reconciling GitHub's eager index-at-install vs index-on-team-add** — today granted repos are indexed at install regardless of team membership; aligning GitHub fully to index-on-first-team-add is a separate refinement.
- **Per-connection disconnect/management redesign** beyond the existing kebab actions.

### Out of scope
- Schema changes to `trello_connections`/`atlassian_connections` (they stay `unique(org_id)`).
- Any change to the per-org KMS/token model.

---

## Risks & Dependencies

- **R1 — Two editors drift.** Until U6 lands, the team-detail picker and the Sources page both write `team_sources`. Sequence U6 with the page so the team-detail goes read-only as the Sources editor ships.
- **R2 — GitHub "available repos" source.** The checklist's "All repositories" needs the full granted-repo set per installation; confirm whether that comes from existing `sources` rows (granted repos are pre-created at install) or a live GitHub App repo list. Default: list the `sources` rows for the installation (they cover granted repos); a live fetch is a refinement.
- **R3 — Master toggle semantics.** Define precisely (bulk add/remove all of a connection's items for the team) and make it idempotent; it's a batch over U4's per-item action.
- **D1 — Builds on shipped `team_sources` + lifecycle** (teams restructure) — no backend lifecycle changes.
- **D2 — Reuses existing connect/select/reindex actions** — extract (not rewrite) the ensure-source upsert for the toggle path.

---

## Sources & Research

- The user's Sources mockup + four confirmed decisions (this session): team-detail read-only, index-on-select via refcount, Slack stub, GitHub-multi-org-only.
- Current surfaces: `apps/portal/app/(authed)/sources/page.tsx` (the `installRows[0]` bug + per-provider reads), `_connection-sources.tsx`, `_github-repo-item.tsx`, `trello-select-action.ts` + `atlassian-select-action.ts` (ensure-source upserts), `api/github/install-callback/route.ts` (granted-repo source creation), `app/_lib/team-source-lifecycle.ts` (`addSourceToTeam`/`removeSourceFromTeam`), `teams/_components/{team-detail,source-picker}.tsx`.
