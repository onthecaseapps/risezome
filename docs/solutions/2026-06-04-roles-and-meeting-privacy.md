---
title: Roles & meeting privacy — the 3-tier model and the master-key reversal
date: 2026-06-04
tags: [security, rls, authz, permissions, multi-tenancy]
type: architecture
---

# Roles & meeting privacy

**Decision:** add a Fireflies-style permission model (plan `2026-06-04-004`) — a
3-tier role hierarchy and a per-meeting privacy level — on top of the existing
participant-scoped RLS, **without** leaving org membership (no external/anonymous
viewing) so the per-org KMS encryption boundary is preserved.

## Two non-obvious things the next reader should know

### 1. `manager` is the stored Admin tier (no rename)

The role vocabulary is `member | manager | super_admin`, where the stored value
**`manager` IS the "Admin" tier** (the UI labels it "Admin"). We deliberately did
**not** rename `manager → admin`: `is_org_manager()` and every `role = 'manager'`
check shipped recently, and a cosmetic rename would re-touch a large surface. New
admin-power gates use `is_org_admin()` (= `manager` OR `super_admin`) so Super
Admin inherits Admin powers; `is_super_admin()` is reserved for the master key.
The DB will reject any other role value (CHECK constraint), and a trigger
guarantees an org always retains ≥1 Super Admin (the master-key holder).

### 2. The Super-Admin master key intentionally REVERSES a documented decision

The original visibility migration (`20260603330000_visibility_and_config_rls.sql`)
narrowed meeting access to participants and explicitly noted **"managers NOT
exempt."** The master key overrides that — but **only for the `super_admin`
tier**, never for Admins. It is implemented as a single `OR is_super_admin(org_id)`
branch inside `can_access_meeting()`, the migration header records the reversal,
and **every master-key access is audited** (app layer — an RLS SELECT can't append
an audit row). If you're tempted to "fix" managers seeing everything: that's not a
bug, and Admins seeing private meetings *would* be.

## Architecture notes

- **One RLS predicate, all capture tables.** `can_access_meeting(meeting_id)` is
  applied uniformly to `meetings`, `cards`, `syntheses`, `meeting_events`, and the
  realtime broadcast policy. They move together on purpose — narrowing only
  `meetings` would leak the payload through a sibling table's REST endpoint. A
  cross-table sibling-leak test guards this.
- **`knowledge_gaps` stays on `can_view_gap`.** Gaps are org-level aggregates
  assembled from `gap_occurrences` across *multiple* meetings — they have no single
  `meeting_id` and can't inherit one meeting's privacy. Their own ACL
  (shared/assignee/admin/participant-seeded `gap_viewers`) already scopes verbatim
  text correctly.
- **The floor is enforced twice** — in the write action and a DB trigger — so a
  direct PostgREST PATCH can't set a meeting below the org floor (the
  `knowledge_gaps.shared_with_org` leak is the precedent). Admin override bypasses
  the floor via a transaction-local GUC (`app.bypass_privacy_floor`) that only the
  self-checking `admin_override_meeting_privacy()` SECURITY DEFINER RPC sets.
- **Writes are service-role only.** Roles, privacy, and audit follow the
  established "RLS reads, service-role writes, no broad client write policies"
  rule. The audit log is append-only and never client-writable.
- **One documented audit gap: the org default/floor change is NOT audited (v1).**
  `setOrgPrivacyConfig` (org `default_privacy` + `privacy_floor`) does not append a
  `permission_audit_log` row — the audit `action` CHECK admits only
  `privacy_change` / `admin_override` / `role_change` / `master_key_access`, and the
  config row's `updated_by`/`updated_at` already records who last changed it. So
  "every privileged write is audited" has this one intentional exception; add a
  `config_change` action later if a floor-change trail is needed.
- **Granting/removing Super Admin requires a Super Admin.** `changeRoleAction`
  gates member<->manager on `requireAdmin`, but minting OR demoting `super_admin`
  (the master-key tier) additionally requires the *caller* to be a super_admin —
  otherwise a manager(Admin) could self-promote to the master key. The DB
  last-super_admin trigger is the atomic backstop, but the app-layer gate is what
  blocks the escalation.
- **The super_admin captures library is exclusion-filtered, not list-audited.**
  RLS grants a super_admin every meeting in the org. The captures *list* would
  decrypt + render restricted recaps with no audit row (only detail pages audit).
  Fix: the list EXCLUDES master-key-only meetings (`isMasterKeyAccess` is true —
  not owner, not participant, `only_me`/`only_participants`) for a super_admin, so
  restricted meetings are reachable only via the review/live pages that DO audit.

## Migration / rollout

Existing meetings backfill to `only_teammates` (library-by-default); each org's
creator is seeded as the initial Super Admin. Pre-launch low volume made this
low-risk. See `SECURITY.md` (Roles & meeting privacy) and
`docs/security/service-role-inventory.md` (§B2).

---

## Update (2026-06-05, teams restructure)

The body above is **historical**. The per-meeting privacy ladder it describes was
**retired** by the teams restructure (plan `2026-06-04-006`, migrations
`20260609010000`…`20260609070000`) — a second production migration over the
plan-004 schema. The model is now simpler:

- **Access is attendees-only.** `can_access_meeting` was rewritten (still the
  single predicate over all five capture tables — the sibling-leak guarantee is
  unchanged) to
  `is_super_admin(org) OR owner OR is_meeting_participant(meeting)`
  (`20260609030000_attendees_only_access.sql`). The 3-level privacy ladder is gone:
  the `meetings.privacy_level` column, the `org_privacy_config` table, the floor
  trigger, `meeting_privacy_rank()`, and the `admin_override_meeting_privacy()` RPC
  were all **dropped**. The owner branch is kept as belt-and-suspenders; the
  super-admin master key (audited at the app layer) is unchanged.
- **Gaps moved to attendees ∪ master key.** `can_view_gap` dropped the
  `assignee_id` branch and tightened the blanket admin branch from manager to
  `is_super_admin` (`20260609070000_gap_assignment_metadata.sql`), so a plain Admin
  no longer sees gaps they didn't attend. The "`knowledge_gaps` stays on
  `can_view_gap`" note above still holds — only the predicate's contents narrowed.
- **Assignment is metadata-only.** Assigning a gap's open question no longer grants
  verbatim: the assignee reads only `{title, asker_name, frequency, last_asked_at,
  status}` via the new `list_assigned_questions()` SECURITY DEFINER fn, never
  `gap_occurrences`. Org-wide assignment is gated/audited in
  `gaps/gap-actions.ts assignGapAction` (`gap_assignment` audit + notification).
- **Audit vocabulary.** `privacy_change` / `admin_override` are **kept in the CHECK
  for historical rows** but no longer written; `team_change`,
  `team_membership_change`, and `gap_assignment` were added
  (`20260609020000_audit_actions_teams.sql`). The "org default/floor change is not
  audited" exception above is therefore moot — that write path no longer exists.
- **Unchanged:** roles (`member`/`manager`/`super_admin`), `is_org_admin` /
  `is_super_admin`, the audited super-admin master key, `meeting_participants`, and
  `org_id` as the per-org KMS/tenancy boundary.

A new **teams layer** (`teams` / `team_members` / `team_sources`, member-read +
service-role-write) and **team-scoped sources** (retrieval filtered to a meeting's
effective source set via `meeting_effective_source_ids`) were added alongside; see
`SECURITY.md` (Roles & access) and `docs/security/service-role-inventory.md` (§B3).
