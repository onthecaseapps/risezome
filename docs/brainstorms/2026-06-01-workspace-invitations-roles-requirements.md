---
date: 2026-06-01
topic: workspace-invitations-roles
---

# Workspace Invitations & Roles — Requirements

## Summary

Let a workspace manager invite teammates via a shareable link, as either a **manager** (full control of sources, settings, the bot, and the member list) or a **member** (a viewer of only their own connected calendar's meetings and captures). Managers can additionally grant a specific member a separate "can invite the bot to meetings" permission. Everyone — managers included — sees only their own meetings, so the manager role confers configuration power, not visibility into other people's meetings.

---

## Problem Frame

Today a workspace has exactly one person: onboarding creates one org and inserts the creator as its sole member. There is no way to add a second person. The immediate need is a co-manager — a teammate who configures sources, settings, and the bot alongside the owner — but the only current options are sharing a login or doing everything yourself.

A second, softer need is read access: people who should be able to see what Risezome is capturing without touching configuration. Because each person's calendar and meetings are already synced per-user, the natural unit of "what a viewer sees" is *their own* calendar — not a shared org feed. That keeps the privacy story clean and avoids exposing one person's calendar to another.

---

## Key Decisions

- **Two roles, one extra grant.** The model is `manager` and `member`, plus a single per-member boolean "can invite the bot." Roles govern configuration authority; the boolean governs whether a member can launch the bot into their own meetings. This is intentionally narrower than a general permission system — two roles and one flag cover the named cases without a policy engine.

- **Visibility is per-person, uniformly.** Every member — manager or not — sees only the meetings and captures from their own connected calendar. The manager role adds configuration authority (sources, settings, bot, members), never cross-member visibility. This is the strongest-privacy option and the simplest to reason about: "you see your own meetings" is true for everyone.

- **Bot-invite is a separate grant, not a tier.** Being able to launch the bot is decoupled from the role. A plain member is a read-only viewer of their own captured meetings; a manager flips "can invite the bot" on for the members they trust to run it themselves. Managers always have it implicitly.

- **This tightens current behavior, deliberately.** Risezome today lets any member toggle the bot onto their own calendar events. Under this model, a newly invited member cannot launch the bot until a manager grants the permission. The default for invited members is *off*.

- **Shareable link first, email later.** Invites are delivered as a link the manager generates and shares through their own channel (Slack, their own email). The recipient signs in with Google and joins. Transactional email — which does not exist in the product today — is deferred to a fast-follow.

- **Members see a reduced surface.** Members do not reach the Sources or Settings pages at all. Their workspace is their own Upcoming events and their own Meetings/captures.

---

## Actors

- A1. **Manager** — can change settings, update/connect sources, toggle the bot, generate invite links, set each invitee's role, grant/revoke "can invite the bot," change members' roles, and remove members. Sees only their own meetings.
- A2. **Member** — sees only their own connected calendar's upcoming events and their own meetings/captures. Cannot reach Sources or Settings. Cannot launch the bot unless granted.
- A3. **Member with bot-invite grant** — a member who has additionally been granted "can invite the bot," letting them launch the bot into their own meetings.
- A4. **Invitee** — a person who has received an invite link but has not yet accepted (no account/membership materialized yet).

---

## Key Flows

- F1. Manager invites a co-manager
  - **Trigger:** Manager opens the member-management surface and creates an invite.
  - **Actors:** A1, A4
  - **Steps:** Manager chooses the role (manager) and optionally the bot-invite grant → a shareable link is generated → manager copies it and sends it via their own channel → invitee opens the link, signs in with Google, and joins the workspace with the assigned role → invitee connects their own calendar and sees their own meetings; as a manager they also see Sources/Settings.
  - **Covered by:** R1, R2, R3, R6, R10

- F2. Manager invites a view-only member
  - **Trigger:** Manager creates an invite with role = member, bot-invite off.
  - **Actors:** A1, A2, A4
  - **Steps:** Same link → sign-in → join flow as F1 → invitee lands on their own Upcoming + Meetings, with no access to Sources or Settings, and cannot launch the bot.
  - **Covered by:** R1, R2, R4, R5, R7, R8

- F3. Manager grants bot-invite to an existing member
  - **Trigger:** Manager toggles "can invite the bot" on for a member in the member list.
  - **Actors:** A1, A3
  - **Steps:** Member's permission flips on → member can now launch the bot into their own meetings → manager can later toggle it back off.
  - **Covered by:** R4, R7, R9

- F4. Manager manages the member list
  - **Trigger:** Manager opens the member-management surface.
  - **Actors:** A1
  - **Steps:** Manager views members (role, bot-invite state, pending invites) → can change a member's role, revoke a pending invite, or remove a member → the last remaining manager cannot be removed or demoted.
  - **Covered by:** R6, R9, R10, R11

---

## Requirements

**Roles & permissions**

- R1. A workspace supports two roles: `manager` and `member`. The workspace creator is a manager.
- R2. Each membership carries a separate "can invite the bot" permission. Managers have it implicitly; for members it defaults to off and is set by a manager.
- R3. Managers can: change settings, connect/update/remove sources, toggle the bot, invite people, assign roles at invite time, change existing members' roles, grant/revoke bot-invite, and remove members.
- R4. Members can: view their own upcoming calendar events and their own meetings/captures. Members cannot access Sources or Settings. A member can launch the bot into their own meetings only if granted bot-invite.

**Visibility**

- R5. Every member, regardless of role, sees only the meetings and captures originating from their own connected calendar. No member (including managers) can see another member's meetings or captures.
- R6. The member-management surface is visible only to managers and lists each member's role, bot-invite state, and any pending (unaccepted) invites.

**Bot control**

- R7. Launching the bot into a meeting requires either the manager role or the bot-invite grant. A plain member without the grant cannot launch the bot, even onto their own events.
- R8. A member without bot-invite still sees captures of meetings the bot did join from their own calendar (e.g. via workspace auto-join), consistent with R5.

**Invitations**

- R9. A manager can generate a shareable invite link that encodes the assigned role and the initial bot-invite grant. Invites can be revoked before acceptance, and the manager can rescind a member after acceptance (R3).
- R10. Accepting an invite requires signing in with Google; on acceptance the invitee becomes a member of the workspace with the role the link specified. An invitee must connect their own calendar before any meetings appear for them.
- R11. A workspace must always retain at least one manager — the last manager cannot be removed or demoted.

---

## Acceptance Examples

- AE1. **Covers R2, R7.** Given a member with bot-invite off, when they open one of their own upcoming events, then they cannot launch the bot. When a manager grants bot-invite and the member reloads, then they can launch the bot into that event.
- AE2. **Covers R4, R6.** Given a member, when they look at the navigation, then Sources and Settings are absent and only their own Upcoming and Meetings are present.
- AE3. **Covers R5.** Given two members in the same workspace each with their own meetings, when member B views their Meetings, then only B's meetings/captures appear and none of A's — and the same is true for a manager.
- AE4. **Covers R9, R10.** Given a manager generates a member invite link and sends it, when a new person opens it and signs in with Google, then they join as a member; if the manager revoked the link first, then opening it does not grant membership.
- AE5. **Covers R11.** Given a workspace with one manager, when that manager attempts to demote or remove themselves, then the action is refused.

---

## Scope Boundaries

**Deferred for later**

- Email-based invitations (sending a branded invite email). Requires adding transactional email infrastructure that does not exist today. Ship the shareable link first.
- Resending/expiring-and-regenerating invites beyond basic revoke, if the link model proves to need more lifecycle controls.

**Outside this product's identity**

- Cross-member visibility / manager oversight dashboards — managers reading other people's meetings or captures. Excluded by the per-person privacy model (R5), not merely deferred.
- Domain allowlist / auto-join (anyone from a domain joins automatically). Weakens precise role assignment; not the shape this feature is taking.
- A general role/permission policy engine. Two roles plus one grant is the deliberate ceiling for this round.

---

## Dependencies / Assumptions

- Calendar events and meetings are already stored per-user (each row is tied to the user whose Google calendar produced it), and Google tokens are stored per-user. The per-person visibility model (R5) builds directly on this; it assumes a member without a connected calendar simply sees nothing until they connect and sync.
- `org_members` already has a `role` column (`admin`/`member` today). This feature assumes the manager role maps onto the existing manager-equivalent role rather than introducing a parallel membership concept; the org creator is the first manager.
- Authentication is Google sign-in. Accepting an invite therefore presumes the invitee can sign in with Google.
- Row-level access today is membership-scoped (any member can read org rows) and not yet role-aware. This feature assumes access becomes role- and owner-aware: configuration writes restricted to managers, and meeting/event reads narrowed to the owning user. The exact policy changes are for planning.

## Outstanding Questions

**Deferred to Planning**

- Invite-link lifecycle specifics (single-use vs reusable, expiry window, what a revoked or already-used link shows on open).
- Whether "manager" reuses the existing `admin` role value or is a renamed/added value, and any data migration for existing single-member workspaces.
- How a member-without-grant who is the *organizer* of a meeting is treated if workspace auto-join is enabled (R8 covers visibility; the launch-authority interaction with auto-join settings should be confirmed during planning).
