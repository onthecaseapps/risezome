---
title: Service-role usage inventory
date: 2026-06-03
tags: [security, rls, multi-tenancy, service-role, least-privilege]
type: reference
---

# Service-role usage inventory

The Supabase **service-role** key bypasses RLS entirely — it is the crown jewel,
so the least-privilege goal is to **shrink the set of code paths that wield it**
and to add defense-in-depth (`org_id` scoping) on the paths that genuinely need
it. This inventory classifies every service-role call site (plan
`2026-06-03-003`, U6). Two clients exist:

- **Authenticated / RLS-respecting** — `apps/portal/app/_lib/supabase-server.ts`
  `createServerClient()` (cookie-bound publishable key, runs as `authenticated`).
  RLS enforces tenant isolation.
- **Service-role / RLS-bypassing** — `createServiceRoleClient()` (portal) /
  `createServiceClient()` (`apps/bot-worker/src/db.ts`), using `SUPABASE_SECRET_KEY`.

**Automated guard.** `scripts/lint/check-service-role-org-scope.mjs` (wired into
`lint`) fails CI on any service-role query against an org-scoped table that lacks
an `org_id` predicate, unless annotated `// service-role-cross-org: <reason>`. The
org-scoped table set is derived from the migrations, so the guard self-maintains.

## Classification

### A. Genuinely needs RLS bypass — org from a trusted, non-client source

These have **no user JWT** (webhooks, background jobs) or resolve the org from a
trusted server-side lookup. Service-role is correct; each is `org_id`-scoped or
annotated as a deliberate cross-org resolution.

| Site | Why bypass is required |
| --- | --- |
| `app/api/recall/webhook/route.ts` | Recall webhook; org resolved from `recall_bot_id` (Recall's globally-unique id). |
| `app/api/atlassian/callback/route.ts`, `app/api/trello/connect/route.ts` | OAuth callbacks; org from an unguessable `state_token` lookup. |
| `app/api/github/webhook/route.ts`, `install-callback/route.ts` | GitHub webhook/callback; HMAC-verified, org bound by `installation_id`. |
| `app/api/auth/callback/route.ts` | Post-OAuth; `user.id` from the exchanged session; resolves org-of-record. |
| `app/invite/[token]/*` | Single-use invite token resolves the org. |
| `src/inngest/functions/*` (indexers, sync-calendar, launch-bot, recap, gaps, purge, **migrate-encryption-to-kms**, **rotate-org-key**, **provision-org-key**) | Background jobs/cron; no user session; org from the trusted event payload. |
| `apps/bot-worker/src/db.ts`, `retrieval.ts`, `skills/trello/source-resolver.ts` | The bot-worker writes `meeting_events`/cards/syntheses on behalf of a meeting it owns; org threaded from the per-meeting runtime. |
| `app/_lib/google-token.ts`, `atlassian-token.ts` | Read/decrypt OAuth tokens from secret tables that have **no client SELECT policy** (service-role-only by design). |

### B. Mutations — kept on hardened service-role (NOT migrated to RLS)

User-facing mutations (pin/confirm/dismiss/end, gap resolve/assign/share, source
settings) run through service-role **server actions** gated by
`requireAuthedUserWithOrg` / `requireManager`, with explicit `org_id` scoping.
They are **intentionally not** moved to client-facing RLS write policies: an
authenticated write policy that only re-asserts row ownership has no column
scoping and becomes the exploit surface recorded in
`docs/solutions/` (the `knowledge_gaps` incident — a non-manager assignee could
set `shared_with_org`). Keeping mutations server-side avoids that antipattern.

### C. Genuine authenticated client writes — column-scoped (U3)

Three write paths legitimately run on the **authenticated** client and rely on
RLS. Because `authenticated` previously held table-level UPDATE on every column,
they were column-scoped via GRANTs (RLS still scopes rows):

| Table | Allowed column | Path |
| --- | --- | --- |
| `calendar_events` | `bot_optin` only | `upcoming/opt-in-action.ts` |
| `notifications` | `read_at` only | `gaps/notification-actions.ts` |
| `workspace_bot_settings` | manager-gated upsert (left as-is — trusted admin, per-org config) | `settings/meeting-bot/save-action.ts` |

`knowledge_gap_sections` client write policies were **dropped** (all writes are
service-role).

### B2. Permission writes — role / privacy / audit (service-role + self-checking RPC)

The permissions overhaul (plan `2026-06-04-004`) follows the same Section B
pattern — RLS reads, service-role writes, no broad client write policies:

| Write | Path | Gate |
| --- | --- | --- |
| Role change (incl. Super Admin) | `members/member-actions.ts changeRoleAction` | `requireAdmin` + service-role + `org_id` scope; **granting OR removing `super_admin` additionally requires the caller to BE a super_admin** (else `forbidden`) — a manager cannot self-promote to the master-key tier; appends `role_change` audit |
| Master-key access | `_lib/meeting-access.ts` (app layer) | logs `master_key_access` when a Super Admin opens a meeting they aren't otherwise entitled to. The captures **library list** EXCLUDES master-key-only meetings for a super_admin (so it never decrypts/renders a restricted recap with no audit row); restricted meetings are reachable only via the review/live detail pages, which DO audit |

`permission_audit_log` is **append-only and Super-Admin-read-only** (RLS SELECT
gated by `is_super_admin`; no INSERT/UPDATE/DELETE policy for any client role).

> **Removed by the teams restructure (plan `2026-06-04-006`, migrations
> `20260609010000`…`20260609070000`).** The per-meeting **privacy ladder** that
> this section previously documented is **gone** — access is now **attendees-only**
> (`can_access_meeting = is_super_admin(org) OR owner OR is_meeting_participant`,
> see `20260609030000_attendees_only_access.sql`). With it, these write paths were
> **deleted**: the owner privacy write (`meetings/[id]/privacy-action.ts
> setMeetingPrivacy`, `privacy_change` audit), the admin-override RPC
> (`admin_override_meeting_privacy()`, `admin_override` audit), and the org
> default/floor upsert (`settings/privacy-action.ts setOrgPrivacyConfig` over
> `org_privacy_config`). The `org_privacy_config` table, the floor trigger,
> `meeting_privacy_rank()`, and `meetings.privacy_level` were all dropped. The
> `privacy_change` / `admin_override` audit actions are **kept in the CHECK for
> historical rows** but are no longer written (`permission_audit_log` is
> append-only, so old rows must stay valid — see
> `20260609020000_audit_actions_teams.sql`). The new write paths replacing them are
> in §B3 below; the previously-documented "`setOrgPrivacyConfig` un-audited in v1"
> exception is therefore moot.

### B3. Teams + team-scoped sources — service-role writes (teams restructure)

The teams restructure (plan `2026-06-04-006`) adds a teams layer and team-scoped
source selection. Tables `teams`, `team_members`, `team_sources` are
**member-readable RLS, service-role-write, no client write policy** (KTD8), same
discipline as §B/§B2. New audited write paths:

| Write | Path | Gate |
| --- | --- | --- |
| Team create / rename / archive | `teams/team-actions.ts` | `requireAdmin` (manager OR super_admin) + service-role + `org_id` scope; appends `team_change` audit |
| Team membership add / remove | `teams/team-actions.ts` | `requireAdmin` + service-role + `org_id` scope; appends `team_membership_change` audit |
| Team source select / deselect | `teams/source-actions.ts` → `_lib/team-source-lifecycle.ts` | `requireAdmin`; does **not** write `team_sources` directly — delegates to the lifecycle entrypoints, which own the refcount-driven **index on first reference** (emit `*.index-requested`) / **de-index on last drop** (mark `sources.status='removed'` + `removed_at`; the existing **purge-removed-sources cron** hard-deletes docs/chunks/embeddings after a grace window). `org_id` resolved server-side from `requireAdmin()` |
| Gap-question assignment | `gaps/gap-actions.ts assignGapAction` | caller must be entitled to the gap (`callerCanViewGap` — attendee ∪ super-admin); target validated to be an `org_members` user; service-role + `org_id` scope; appends `gap_assignment` audit + a `notifications` row. **Metadata-only:** sets `assignee_id` but deliberately does **not** seed `gap_viewers`, so a non-attendee assignee gains **no** verbatim (they read only question/asker/metrics via `list_assigned_questions()`) |

The audit `action` CHECK gained `team_change`, `team_membership_change`, and
`gap_assignment` (`20260609020000_audit_actions_teams.sql`). `meeting_participants`
is the attendee baseline that `can_access_meeting` and
`meeting_effective_source_ids` (the retrieval source-set resolver,
`20260609060000_search_rpcs_source_filter.sql`) both key on. No new
client-callable privileged RPC was added (the dropped `admin_override_meeting_privacy`
was the only one); `is_team_member()`, `meeting_effective_source_ids()`, and
`list_assigned_questions()` are SECURITY DEFINER **read** helpers, not writers.

### D. Reads — migration to the authenticated client (KTD5)

Server-side **reads** that act on behalf of the signed-in user are being moved
onto `createServerClient()` so RLS enforces tenant isolation as a second layer
(plan U4/U5). Exceptions that stay service-role with inline justification:

- Admin `auth.users` display-name resolution (`members/member-actions.ts`) — the
  admin auth API cannot run under RLS.
- Reads of teammate-owned rows not exposed by current RLS SELECT policies — moved
  only where a column-scoped org-member SELECT policy exists.
- `upcoming/page.tsx` `lookupLastSyncedAt` (per-user `calendar_events` read) —
  tracked in the guard's allowlist; migrates when that file's unrelated WIP lands.

## Residual / follow-ups

- **Network Restrictions** on the Postgres SQL port (Fly/portal egress allowlist)
  — additive; does not protect the HTTPS data APIs, so it complements (not
  replaces) keeping the key secret.
- **Per-workload service-role keys / dedicated `BYPASSRLS` roles** and `pgaudit`
  attribution for privileged writes — deferred hardening.
