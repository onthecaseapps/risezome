# Security

How Risezome protects its own infrastructure and our customers' data. Risezome
connects to a team's tools (GitHub, Jira/Confluence, Trello, Google Calendar) and
their meetings, retrieves relevant context, and surfaces synthesized answers.
That means we hold two sensitive things: **customer credentials** (OAuth tokens
to their tools) and **customer content** (ingested code/docs and meeting
transcripts). This document describes the controls protecting both.

_Last reviewed: 2026-06-04. Every claim here is intended to be true against the
code at the time of writing; update it when controls change._

## Cryptography policy

**We use vetted, industry-standard cryptography only — we never roll our own.**

- **At rest:** the **AWS Encryption SDK** with **per-organization KMS keys**
  (envelope encryption; AES-256-GCM performed in `node:crypto`). Each org's data
  is encrypted under its own KMS Customer Master Key (alias
  `alias/<prefix>-org-<org_id>`); the SDK wraps a per-message data key, binds the
  `org_id` as encryption context, and a caching layer keeps the hot path off KMS.
  Crypto runs **app-side**, so the database only ever stores opaque ciphertext —
  no key and no plaintext ever reach the DB server. (Local dev/CI use a vetted
  `node:crypto` RawAES fallback keyed by `RISEZOME_DEV_CRYPTO_KEY`; production
  uses KMS.) See [`@risezome/crypto`](packages/crypto/src/envelope.ts).
- **In application code:** Node's OpenSSL-backed `node:crypto` for HMAC,
  constant-time comparison (`timingSafeEqual`), HKDF, and CSRF nonces
  (`randomBytes`).
- **Comparisons** of secrets/MACs are constant-time; never `===`.

**Why per-org KMS keys.** Against the threat that matters most once we hold
customer code — **app/key compromise or a malicious insider** — key custody
*outside* the application process is the only control that helps: a leaked
encryption key (or a DB-level insider) is **capped to a single org**, every
decrypt is auditable (CloudTrail), and a compromised org's key can be **revoked
instantly** by disabling its CMK. In-app schemes (a single global key, or keys
derived in-process) would not change that posture.

## Credentials & secrets at rest

- **Third-party OAuth tokens are encrypted at rest** under the org's per-org KMS
  key: Google refresh token, Atlassian (Jira/Confluence) access + refresh tokens,
  and the Trello token. The key is custodied in AWS KMS — **the database never
  stores it and the app process never holds the master** — so a database dump,
  backup, or read replica yields only ciphertext, and a leaked key exposes at
  most one org.
- **GitHub** uses the GitHub App model: short-lived installation tokens are
  minted on demand, so no long-lived GitHub token is stored.
- **Key rotation & revocation** are per-org: KMS rotates the wrapping key, a
  per-org re-encryption job rotates data keys without forcing re-auth, and
  disabling an org's CMK revokes access to that org's data instantly. See
  [`docs/runbooks/encryption-key-rotation.md`](docs/runbooks/encryption-key-rotation.md).
  The one-time migration from the legacy global key is documented in
  [`docs/runbooks/encryption-kms-migration.md`](docs/runbooks/encryption-kms-migration.md).
- **Platform secrets** (Recall API key + webhook secret, bot-worker shared
  secret, GitHub App private key, Supabase keys, AI-provider keys) live in
  environment variables only — never committed (enforced by `.gitignore`) and
  **never written to logs**.

## Tenant data isolation

Customer data is multi-tenant in one Postgres database; isolation is enforced at
the database, not just the application.

- **Row-Level Security (RLS) is enabled and org-scoped on every customer-data
  table** (ingested docs/chunks/embeddings, meetings, transcripts, captures,
  syntheses, knowledge gaps). Meeting content is further narrowed by a
  **per-meeting privacy level** (see Roles & meeting privacy below), enforced in
  RLS across every capture table at once.
- **Secret tables are service-role-only** (RLS enabled, no policies): token
  connections, install state, indexer cursors — members can never read them.
- **The server-derived org is the only source of truth.** Tenant-boundary
  decisions never trust a client-supplied org id; identifiers come from the
  authenticated session / verified JWT.
- **No over-broad client writes.** Privileged mutations (pin/dismiss, gap
  confirm/share, source config) go through org-checked service-role actions. The
  few genuine client writes are **column-scoped** via GRANTs (a user can only
  flip `calendar_events.bot_optin` or `notifications.read_at` on their own row,
  not rewrite other columns); there are no broad client `UPDATE` policies a
  crafted PostgREST request could abuse.
- **Service-role least privilege.** Service-role queries that act on
  client-supplied ids re-assert `org_id` (defense-in-depth), enforced by an
  automated CI guard (`scripts/lint/check-service-role-org-scope.mjs`) that fails
  the build on any unscoped service-role query against an org table. Read paths
  that act for the signed-in user are being moved onto the RLS-respecting
  authenticated client so the database enforces isolation as a second layer.
  Every service-role call site is classified in
  [`docs/security/service-role-inventory.md`](docs/security/service-role-inventory.md).

## Roles & meeting privacy

A three-tier role hierarchy and a per-meeting privacy model govern who can see a
recorded meeting (audio, transcript, AI summary, cards).

- **Roles** (`org_members.role`): **Member**, **Admin** (stored as `manager`),
  and **Super Admin** (`super_admin`). Admin manages settings, billing,
  integrations, members, and the org privacy default + floor — but an Admin
  **cannot** read meetings they aren't otherwise entitled to. Only a **Super
  Admin** holds the "master key." Role checks run through `SECURITY DEFINER`
  helpers (`is_org_admin`, `is_super_admin`) to avoid RLS recursion; an org can
  never be left with zero Super Admins (a DB trigger enforces it).
- **Per-meeting privacy levels**: **Only Me** (owner only), **Only Participants**
  (org-member attendees), **Only Teammates** (the whole workspace — the
  library-by-default). The level is set by the first person to invite the bot
  (the meeting owner) and is enforced by a single `can_access_meeting()` RLS
  predicate applied uniformly to `meetings`, `cards`, `syntheses`,
  `meeting_events`, and the realtime broadcast — so a hidden meeting cannot leak
  through a sibling table.
- **Org default + floor**: an Admin sets the org-wide default level and a
  **privacy floor** (the most private a Member may choose), enforced both in the
  write action and by a DB trigger so a direct PostgREST write can't go below it.
- **Master key, audited**: a Super Admin can access any meeting regardless of
  privacy (an explicit, deliberate exception to the otherwise-absolute privacy
  rule — Admins are *not* exempt). Every master-key access — and every privacy
  change and role change — is recorded in an **append-only, Super-Admin-readable
  audit log** (`permission_audit_log`; no client can write, update, or delete it).
- **External/anonymous viewing is not supported** — all access stays inside org
  membership, preserving the per-org KMS encryption boundary.

## Customer content protection

- **Sensitive meeting content is encrypted at rest** under the org's per-org KMS
  key (decrypted server-side only): the whole-meeting **recap**, the AI's
  **synthesized answers**, and the **verbatim transcript text**. Transcript
  speaker names + timing stay in plaintext metadata (so they remain queryable),
  but the spoken words themselves are encrypted.
- The remaining customer content held in plaintext is the **search corpus**
  (document chunks + vector embeddings), which relies on **disk-level**
  encryption plus RLS — column-encrypting it would break full-text and vector
  search. This is a deliberate, documented decision; the rationale and
  follow-ups are recorded in
  [`docs/solutions/2026-06-03-content-encryption-at-rest.md`](docs/solutions/2026-06-03-content-encryption-at-rest.md).
- **Disconnect purges content.** When a source is disconnected, its ingested
  content and embeddings are deleted (cascade) after a short grace window — data
  doesn't linger after a customer removes a connection.
- **Org deletion cascades** through all content tables.
- **Logs don't carry customer content.** Verbatim transcripts are redacted from
  logs by default (length/ids only), and request logging never records the
  WS-auth token that travels in the URL.

## Transport & request authenticity

- **TLS everywhere** to external services and providers.
- **Webhooks are signature-verified** before processing: Recall (svix) and GitHub
  (HMAC-SHA256 with constant-time comparison). Forged events are rejected.
- **Service-to-service auth** (portal ⇄ bot-worker) uses an `HS256` JWT with the
  algorithm pinned (no `alg:none`), expiry enforced, and meeting binding checked;
  the control endpoint requires the shared secret (constant-time).
- **OAuth flows** use single-use, server-side CSRF state tokens (anti-replay),
  and authorization codes/tokens are never placed in redirect URLs or logs.

## Data sub-processors

Some customer content is sent to external AI providers (Voyage for embeddings,
Anthropic for synthesis) under zero-retention terms. **AWS KMS** custodies the
per-org encryption keys (it performs key wrap/unwrap; customer *content* is never
sent to KMS). See [`docs/security/sub-processors.md`](docs/security/sub-processors.md).

## Reporting a vulnerability

If you believe you've found a security vulnerability, please email
**security@onthecaseapps.com** with details and steps to reproduce. Please do
**not** open a public issue. We'll acknowledge receipt, investigate, and keep you
updated on remediation. We appreciate responsible disclosure and will credit
reporters who wish to be acknowledged.
