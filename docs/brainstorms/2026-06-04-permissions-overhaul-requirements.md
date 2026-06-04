# Permissions Overhaul — Roles & Meeting Privacy

**Created:** 2026-06-04
**Status:** Requirements (ready for `/ce-plan`)
**Topic:** A Fireflies-style permissions structure for Risezome — a 3-tier role hierarchy plus a per-meeting privacy model that makes recorded meetings a workspace-shared library by default, with an admin compliance lever and an audited master key.

---

## Problem Frame

Today Risezome has a flat, implicit access model: org membership is `manager | member`, and every meeting is **participant-scoped** — readable only by the people who actually attended it (`public.is_meeting_participant(meeting_id)`, enforced in RLS; see `supabase/migrations/20260603320000_meeting_dedup_and_participants.sql` and `20260603330000_visibility_and_config_rls.sql`). There is no per-meeting privacy control, no shared library, no role above `manager`, and no compliance/oversight path.

This blocks three things teams expect from a meeting-intelligence product:
1. **A shared library** — teammates can't discover or learn from each other's meetings; knowledge stays siloed to attendees.
2. **Intentional privacy** — there's no way to mark a sensitive 1:1 as private, nor to guarantee a meeting stays inside the workspace.
3. **Oversight & compliance** — no admin can enforce org-wide privacy norms, and no one holds an auditable "master key" for compliance review.

This overhaul introduces an explicit, configurable permission model that delivers all three **without** leaving the org-membership trust boundary the product (and the new per-org KMS encryption) is built on.

---

## Core Outcome

A member records a meeting; by default it joins the **workspace library** (visible to all teammates), but the member can dial privacy down (to attendee-only or just themselves) within whatever **floor** their Admin has set. Admins configure org-wide defaults and the floor. A single audited **Super Admin** can access any meeting for compliance, and every such access is logged.

---

## Actors

- **A1 — Member.** Standard user. Can invite the bot to their meetings (subject to the existing `org_members.can_invite_bot` grant), review their own meetings, and access the shared library per privacy rules. Sets the privacy level on meetings they record.
- **A2 — Admin.** Today's `manager` role maps here. Manages org settings, billing, integrations, member management, **and** the org-wide privacy default + floor. Can override any individual meeting's privacy. **Does not** bypass privacy to read meetings they aren't otherwise entitled to.
- **A3 — Super Admin.** The compliance/oversight role. Holds the **master key**: can access **all** meetings in the org regardless of privacy level. Every master-key access is recorded in an audit log. (Distinct from Admin precisely so that running billing/settings does not come with the ability to read private 1:1s.)
- **A4 — Meeting Owner (per-meeting role, not an org role).** The **first person to invite the bot** to a meeting. Owns that meeting's privacy setting and can change it later within the floor. Maps to the meeting's launcher (`meetings.user_id` today).
- **A5 — External participant (out of scope for v1).** A non-workspace person who attended a meeting. In v1 they receive **no** access to recordings/transcripts/summaries — all privacy levels are org-internal. Documented so the model degrades predictably, not silently.

---

## Requirements

### Roles

- **R1.** The org role vocabulary becomes three tiers: **Member**, **Admin**, **Super Admin** (replacing today's `manager | member`). Existing `manager` → **Admin**; existing `member` → **Member**.
- **R2.** Admin powers: org settings, billing, integrations, member management, and setting the org-wide privacy **default** and **floor** (R8, R9). Admin can override any single meeting's privacy (R12). Admin does **not** gain privacy bypass.
- **R3.** Super Admin holds the master key: read access to **every** meeting in the org regardless of its privacy level (the audio, transcript, and AI summary). Super Admin also has all Admin powers.
- **R4.** The existing `can_invite_bot` grant remains an **orthogonal** per-member capability (separate from role) — it gates who may launch the bot, independent of Member/Admin/Super Admin.

### Meeting privacy levels (v1)

- **R5.** Every meeting carries a **privacy level**. v1 exposes three, ordered most-private → least-private:
  1. **Only Me** — only the Meeting Owner (A4) can access.
  2. **Only Participants** — org-member attendees of that meeting can access (external attendees excluded, per A5).
  3. **Only Teammates** — every member of the workspace can access (the shared library).
- **R6.** The privacy level controls access to the **full meeting payload**: audio, transcript, AI summary/recap, and synthesized answers — consistently. A level change applies to all of them together.
- **R7.** The **Meeting Owner** is the first person to invite the bot, and their choice sets the meeting's initial privacy (subject to the org default + floor). When multiple teammates are present, only the Owner's setting governs.

### Org defaults & floor

- **R8.** Each org has a configurable **default privacy level** applied to new meetings. The shipped default is **Only Teammates** (library-by-default — the v1 realization of the "Participants + Teammates" intent).
- **R9.** Each org has a configurable **privacy floor** — the most-private level a Member may select. Setting the floor above "Only Me" forbids fully-private meetings; setting it at "Only Teammates" forces everything to stay workspace-visible. The Owner may choose any level **at or less private than nothing below the floor** (i.e., the floor is the most-private allowed).
- **R10.** A Member's per-meeting choice is constrained by the floor. Levels below the floor are unavailable to Members. (Admin override per R12 may still go below the floor for moderation.)

### Lifecycle & oversight

- **R11.** The Meeting Owner can change their meeting's privacy level **after** creation, within the floor.
- **R12.** An Admin (or Super Admin) can **override** any meeting's privacy level (e.g., to correct an over-share or under-share). Admin override is not constrained by the floor.
- **R13.** **Audit log:** every privacy-level change (who, when, old → new, on which meeting) **and** every Super-Admin master-key access (who accessed which meeting, when) is recorded in an append-only audit trail. This is what makes "compliance and oversight" trustworthy rather than silent surveillance.

### Migration

- **R14.** Existing meetings, which are participant-only today, are assigned **Only Teammates** on migration (consistent with the library-by-default outcome) — i.e., they become workspace-visible.
- **R15.** On migration, the org creator/owner is seeded as the initial **Super Admin** so a master-key holder always exists; remaining `manager`s become **Admin**, `member`s become **Member**. (See Open Questions — confirm the seeding rule.)

---

## Key Flows

- **F1 — Set privacy while recording.** Member invites the bot → meeting is created with the org default privacy (R8), shown to the Owner → Owner may adjust within the floor (R7, R10).
- **F2 — Browse the library.** A teammate opens the workspace library and sees every meeting at **Only Teammates**, plus meetings they participated in at **Only Participants**, plus their own at any level. Meetings below their entitlement are not listed.
- **F3 — Admin configures the org.** Admin sets the org default level and the floor (R8, R9); the change governs new meetings and constrains Member choices (R10).
- **F4 — Owner changes privacy later.** Owner opens a past meeting and changes its level within the floor (R11); the change is audited (R13).
- **F5 — Admin overrides a meeting.** Admin opens a mis-shared meeting and corrects its privacy (R12); change is audited (R13).
- **F6 — Super Admin master-key access.** Super Admin opens a meeting they aren't otherwise entitled to; access is granted (R3) and recorded in the audit log (R13).

---

## Acceptance Examples

- **AE1.** A Member records a 1:1, sets it to **Only Me**. A teammate (not a participant) cannot find or open it; an Admin cannot open it; the Super Admin **can** open it, and that access appears in the audit log. *(R3, R5, R13)*
- **AE2.** With the org default at **Only Teammates**, a Member records a team standup and changes nothing. Every teammate can open it from the library; an external attendee gets no access. *(R5, R8, A5)*
- **AE3.** An Admin sets the floor to **Only Participants**. A Member trying to record a meeting finds **Only Me** unavailable; the most private they can pick is Only Participants. *(R9, R10)*
- **AE4.** A Member accidentally leaves a sensitive board call at **Only Teammates**. An Admin overrides it to **Only Participants**; the override is audited; the board call disappears from the general library. *(R12, R13)*
- **AE5.** An Admin (not Super Admin) opens the library and cannot see or open any **Only Me** meeting they didn't record — confirming Admin ≠ privacy bypass. *(R2, R3)*
- **AE6.** A meeting with only external attendees (the Member who launched the bot is the sole org member) set to **Only Participants** is visible only to that Member — i.e., it degrades to Only-Me behavior, with no error. *(A5, R5)*

---

## Scope Boundaries

### In scope (v1)
Three-tier roles; the three internal privacy levels; org default + floor; owner/admin lifecycle changes + audit log; Super-Admin master key + access audit; migration of existing roles and meetings.

### Deferred for later
- **"Anyone with link"** (anonymous/public sharing) and **external-participant viewing** — both require serving decrypted per-org content to non-members, a new public/external access path that reopens the exposure the per-org KMS encryption just narrowed. When they land, the level set grows back to the full **five** (adding **Participants + Teammates** and **Anyone with link**), and the v1 storage model should accommodate them without migration.
- **Super-Admin plan-gating** (Enterprise-only) — there are no plan tiers in the product yet; treat Super Admin as an assignable role for now.
- **Generalizing the privacy primitive** to other shareable resources (e.g., `knowledge_gaps.shared_with_org` already hints at a per-resource sharing concept) — keep privacy on meetings for v1; consider a shared primitive only if a second resource needs it.

### Outside this product's identity
- Privacy levels are **org-internal trust controls**, not a public publishing/CMS feature. Risezome is a workspace meeting-intelligence tool; "share a meeting on the open web" is a different product and is not a goal even long-term without a deliberate decision.

---

## Dependencies & Assumptions

- **D1 — Per-org KMS encryption boundary.** Recap/synthesis/transcript are encrypted under the org's KMS key and decryptable only server-side for org-resolved requests (`packages/crypto/src/envelope.ts`, security plan `docs/plans/2026-06-03-003-...`). Super Admin is in the org, so master-key decryption works with no collision. This boundary is *the* reason external/anonymous viewing is deferred — keep the v1 model entirely inside org membership.
- **D2 — Meeting Owner = launcher.** "First person to invite the bot" maps to the existing meeting launcher (`meetings.user_id`). Planning should confirm this holds for all bot-launch paths (calendar auto-join, manual invite, recall webhook).
- **D3 — Participant model.** "Only Participants" builds on the existing `meeting_participants` table and `is_meeting_participant()`; "Only Teammates" builds on `org_members`. RLS is the enforcement layer (consistent with the current participant-scoped policies).
- **D4 — Writes are service-role-gated.** Today all `org_members` and meeting mutations flow through org-checked service-role server actions with no broad client write policies (per the security work + `docs/security/service-role-inventory.md`). Role changes, privacy changes, and overrides should follow the same pattern; the new audit log must capture them.
- **A-assume1.** Existing data volume is low (pre-launch), so the migration (R14, R15) is low-risk.
- **A-assume2.** The audit log is append-only and itself service-role-only (members cannot read or alter it); retention/exposure policy is a planning detail.

---

## Open Questions (for planning)

- **Q1 — Super Admin seeding.** Is the org creator auto-seeded as the sole initial Super Admin (R15), or is Super Admin left unassigned until an Admin grants it? (Risk: zero master-key holders if unassigned.) Recommend seeding the creator.
- **Q2 — Number of Super Admins.** One per org, or many? Recommend allowing multiple but surfacing the count to Admins (each is an unaudited-by-peers master key... actually audited — but each expands compliance-access reach).
- **Q3 — Floor vs existing meetings on tightening.** If an Admin later raises the floor (e.g., forbids Only Me), what happens to meetings already at a now-disallowed level — auto-raised, flagged, or left as-is? Recommend leaving existing meetings as-is and only constraining new choices, with an optional admin sweep.
- **Q4 — Audit log surface.** Where/whom is the audit log exposed to (Super Admin only? Admin? export)? Out-of-scope to design here; flag for planning.
- **Q5 — Library discoverability.** Does "Only Teammates" mean a meeting is actively listed in a browsable library UI, or just accessible-if-linked? Recommend an actual library/list view, but the UI is a planning/design decision.
