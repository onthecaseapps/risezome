# Teams Restructure (Org → Teams) with Top-Bar Shell

**Created:** 2026-06-04
**Status:** Requirements (ready for `/ce-plan`)
**Topic:** Restructure the workspace into **Org (name + global settings + billing) → Teams (multi-membership)**, simplify content access to **attendees-only** (dropping the just-shipped privacy ladder and the grant/share model that was briefly considered), make **knowledge-gap questions assignable org-wide**, move sources to teams (companion doc), and add the **top-bar shell**.

> **Supersedes** the privacy/sharing portions of `docs/brainstorms/2026-06-04-permissions-overhaul-requirements.md` / plan `2026-06-04-004` (shipped + deployed). **Kept** from that work: the 3-tier roles, the audited Super-Admin master key, and `permission_audit_log`. **Reworked away:** the fixed 3-level privacy ladder (`only_me`/`only_participants`/`only_teammates`), `org_privacy_config` + floor + rank, and `admin_override_meeting_privacy` — replaced by the much simpler **attendees-only** model below. An earlier draft of this doc proposed a grant/share model (share-to-user/team/org); **that is dropped** — access is attendees-only, full stop.
>
> **Companion:** `docs/brainstorms/2026-06-04-team-scoped-sources-requirements.md` covers the sources dimension (sources move from org-scoped to team-scoped, deduplicated indexing). This doc covers structure, access, roles, onboarding, and the shell.

---

## Problem Frame

The product is flat: one org, content visible by per-meeting privacy level. There's no **team** — the unit people actually work in. Visibility is a fixed 4-level ladder that's more machinery than the product needs. And the shell crowds the org switcher, user menu, and notifications into the sidebar.

This restructures around **teams**, collapses access to the simplest correct rule (**the people in the room see the meeting**), routes a meeting's *context* through the attendees' teams (companion sources doc), and lifts org/identity/notifications into a **top bar**.

---

## Core Outcome

People are organized into **teams** (many per person) within a single **Org** that's just a name + billing + global settings. A meeting, its captures, and its knowledge gaps are **visible only to its attendees**. A gap's open **questions can be assigned to anyone in the org** (the assignee sees only the question, who asked it, and metrics — never verbatim meeting content). A top bar carries the Org brand, a team switcher (browse lens), notifications, and the user menu; the sidebar slims to a nav icon rail.

---

## Actors

- **A1 — Member.** Belongs to one or more teams. Sees meetings/captures/gaps they **attended**. Can be **assigned** gap questions from anywhere in the org (sees question + asker + metrics only).
- **A2 — Admin** (stored `manager`). Manages the org, members, **teams** (create, rename, archive, add/remove members), **team source lists** (companion doc), and integrations. Does **not** see meetings they didn't attend. No privacy bypass.
- **A3 — Super Admin.** The **audited master key** — sees every meeting regardless of attendance, for compliance. All Admin powers. Every master-key access is audited.
- **A4 — Meeting Owner.** First person to invite the bot (`meetings.user_id`). An attendee like any other for visibility; owns the meeting record.
- **A5 — Team.** A named group within the org (name + slug, e.g. `#platform-eng`). The membership unit, the browse lens, and (companion doc) the source-selection unit. Not a content container — meetings are not "filed" to a team; a team groups people and the sources its meetings draw on.

---

## Requirements

### Org & Teams

- **R1.** The **Org** is the top-level container — a **name + global settings + billing**. Not user-switchable, not managed day-to-day. (`org_id` remains the tenancy + KMS encryption key under the hood — unchanged.)
- **R2.** **Teams** belong to an org; a team has a name + slug. A member belongs to **one or more** teams.
- **R3.** Users are invited to the **Org**, then **added to teams**. Org membership and team membership are distinct: an org member may be on zero or many teams.
- **R4.** **Team management is an Admin power** (create/rename/archive, add/remove members). No per-team lead role in v1.

### Content access — attendees only

- **R5.** **Live meetings and captures are visible only to the meeting's attendees** (the org-member participant set, `meeting_participants`) plus the **Super-Admin master key**. There is no privacy ladder, no per-meeting privacy setting, and no sharing/grant model. "The people in the room see it."
- **R6.** Access to a meeting's full payload (audio, transcript, AI summary, cards, syntheses, realtime broadcast) is **attendees ∪ super-admin** — enforced **uniformly across all capture tables** so a meeting hidden on `meetings` cannot leak through a sibling table's REST endpoint (the sibling-leak guarantee from the shipped work must hold). The access predicate collapses to: `is_meeting_participant(meeting) OR is_super_admin(org)`.
- **R7.** **Knowledge gaps are visible only to the attendees** of the meetings that fed them (the existing participant-seeded gap ACL already enforces this). Gaps are **not** org-wide readable.
- **R8.** **A gap's open questions can be assigned to anyone in the org.** Assignment is an org-wide action; **being assigned a question does not grant access to the gap's verbatim content.** The assignee sees **only**: the question text, who asked it, and the gap's **metrics** (e.g. how often/where it recurred) — no transcript excerpts, no source verbatim.

### Roles & oversight (kept from the shipped model)

- **R9.** Roles stay **org-level**: Member / Admin / Super Admin. Admins manage org + teams + members + team sources; they do **not** see meetings they didn't attend. Only the **Super-Admin master key** sees everything.
- **R10.** **Audit log** (`permission_audit_log`, kept): record role changes, team create/rename/archive, team-membership changes, gap-question assignments, and every Super-Admin master-key access. Append-only, Super-Admin-readable.

### Sources (companion doc)

- **R11.** Sources move from org-scoped to **team-scoped**; a meeting's usable sources are the **union of its attendees' teams' sources**, indexed once and reference-counted. Full requirements in `docs/brainstorms/2026-06-04-team-scoped-sources-requirements.md`.

### Top-bar shell

- **R12.** Add a **top bar**: left = **Org brand** + **Team switcher** (switch the browse lens — "Org / #team" with a Switch-team dropdown); right = **notifications** and a **user-avatar dropdown** (Profile & account, Notification settings, Sign out — no "switch workspace," there's one org). Move org/user/notifications out of the sidebar; the sidebar slims to a **nav icon rail**. (No "Share" action — there's no sharing in this model.)
- **R13.** **Team switcher is a browse lens.** Selecting a team scopes the browsing views (captures list, etc.) to that team's context; a "my meetings" / attended view also exists. Visibility is still attendees-only — the lens filters what you browse, it does not grant access.

### Onboarding & migration

- **R14.** **Onboarding:** the Super Admin names the **Org** and creates the **first team(s)**; members are invited to the org, then assigned to teams.
- **R15.** **Migration:** rework the shipped privacy model into attendees-only — drop `privacy_level` + `org_privacy_config` + floor/rank + `admin_override`; collapse `can_access_meeting` to attendees ∪ super-admin. Seed a **default team per org** with all members + (companion doc) all existing sources. Pre-release; the dev's test orgs reshape freely. (Second production migration over the just-deployed permissions schema — see Risks.)

---

## Key Flows

- **F1 — Record → attendees only.** A member records a meeting; it's visible to its attendees, full stop.
- **F2 — Assign a gap question.** From a gap, an attendee assigns an open question to any org member; the assignee is notified and sees the question + asker + metrics (no verbatim). Audited.
- **F3 — Switch team.** A member switches teams in the top bar to browse that team's context.
- **F4 — Admin manages teams.** An admin creates a team, adds members, and curates its sources (companion doc).
- **F5 — Super-Admin master key.** A super admin opens a meeting they didn't attend; access is granted and an audit row is written.

---

## Acceptance Examples

- **AE1.** A meeting is invisible to a non-attendee Admin; the Super Admin can open it and that access is audited. *(R5, R6, R9, R10)*
- **AE2.** A member denied a meeting is also denied its cards/syntheses/transcript and its realtime broadcast (no sibling-table leak). *(R6)*
- **AE3.** A gap question assigned to a non-attendee shows that person the question, the asker, and the metrics — and **no** transcript or source verbatim. *(R8)*
- **AE4.** A knowledge gap is not visible to an org member who attended none of its source meetings (unless assigned a question per AE3). *(R7)*
- **AE5.** A meeting's retrieval draws only on the union of its attendees' teams' sources; a board no attendee's team includes never surfaces. *(R11, companion doc)*
- **AE6.** After migration, every existing meeting is attendees-only and every existing source belongs to its org's default team; prior retrieval behavior is preserved. *(R15)*

---

## Scope Boundaries

### In scope (v1)
Org-as-brand + Teams + multi-team membership; attendees-only access for meetings/captures/gaps; org-wide gap-question assignment (metadata-only for the assignee); team-scoped sources (companion doc); the top-bar shell + team-switcher browse lens; onboarding (org + first teams); migration off the privacy ladder; kept roles + audit + master key.

### Deferred to follow-up
- **Sharing / grants of any kind** (share a meeting to a user/team/org). Deliberately out — access is attendees-only. Revisit only if a real need appears.
- **Per-team lead role** (delegated team management).
- **Rules-engine / auto-routing** of meetings to teams.
- **Notification redesign** beyond carrying the current bell and adding the gap-assignment notification.

### Outside this product's identity
- **External / anonymous viewing** — all access stays inside org membership (preserves the per-org KMS boundary).

---

## Open Questions (for planning)

- **Q1 — Gap-question assignment surface.** Where assignment lives in the UI and the exact "metrics" shown to an assignee (recurrence count, last-seen meeting title? — title may itself be sensitive; default to non-verbatim aggregates only). Planning to pin the assignee payload precisely against the existing gap schema.
- **Q2 — Master-key captures-list behavior.** The shipped fix excludes master-key-only meetings from a super-admin's captures *list* (so it never renders a restricted recap unaudited). Confirm that exclusion logic carries over unchanged to the attendees-only model (now "not an attendee" replaces "below privacy").
- **Q3 — Team switcher vs. "all my meetings."** Exact default view and whether the lens persists across sessions (cookie like the current org selection).

---

## Dependencies & Assumptions

- **D1 — Reworks just-deployed work.** Drops `privacy_level` + `org_privacy_config` + floor + rank + `admin_override_meeting_privacy` from plan `2026-06-04-004` (deployed today); **keeps** roles, `is_org_admin`/`is_super_admin`, the master key, and `permission_audit_log`. A second production migration over the first — pre-release, acceptable, but real churn + another `db push`.
- **D2 — Attendee = the participant set** (`meeting_participants`, established at launch). The access predicate and the sources union both build on it.
- **D3 — KMS encryption unchanged.** `org_id` stays the tenancy + encryption key; teams add an access/selection layer, not a crypto change.
- **D4 — Enforcement is RLS.** A collapsed `can_access_meeting` (attendees ∪ super-admin) across all capture tables, with the sibling-leak guarantee; writes (roles, team membership, gap assignment) stay service-role + audited.
- **D5 — Gap ACL largely unchanged.** The existing participant-seeded `gap_viewers` + `can_view_gap` already enforce attendees-only gap visibility; the new work is the **org-wide assignment** axis and its metadata-only assignee view, not a gap-visibility rewrite.
