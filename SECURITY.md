# Security

How Risezome protects its own infrastructure and our customers' data. Risezome
connects to a team's tools (GitHub, Jira/Confluence, Trello, Google Calendar) and
their meetings, retrieves relevant context, and surfaces synthesized answers.
That means we hold two sensitive things: **customer credentials** (OAuth tokens
to their tools) and **customer content** (ingested code/docs and meeting
transcripts). This document describes the controls protecting both.

_Last reviewed: 2026-06-03. Every claim here is intended to be true against the
code at the time of writing; update it when controls change._

## Cryptography policy

**We use vetted, industry-standard cryptography only — we never roll our own.**

- **At rest:** pgcrypto's OpenPGP symmetric encryption (`pgp_sym_encrypt`,
  `cipher-algo=aes256`) via shared SQL helpers — not hand-written ciphers.
- **In application code:** Node's OpenSSL-backed `node:crypto` for HMAC,
  constant-time comparison (`timingSafeEqual`), and CSRF nonces (`randomBytes`).
- **Comparisons** of secrets/MACs are constant-time; never `===`.

## Credentials & secrets at rest

- **Third-party OAuth tokens are encrypted at rest** with pgcrypto AES-256:
  Google refresh token, Atlassian (Jira/Confluence) access + refresh tokens, and
  the Trello token. The symmetric key lives only in the
  `USER_TOKEN_ENCRYPTION_KEY` environment variable — **the database never stores
  it**, so a database dump, backup, or read replica yields only ciphertext.
- **GitHub** uses the GitHub App model: short-lived installation tokens are
  minted on demand, so no long-lived GitHub token is stored.
- **Key rotation** without forcing re-auth is supported via a re-wrap procedure
  (decrypt-old / re-encrypt-new, per-row versioned). See
  [`docs/runbooks/encryption-key-rotation.md`](docs/runbooks/encryption-key-rotation.md).
  The production key is kept distinct from any developer's local key.
- **Platform secrets** (Recall API key + webhook secret, bot-worker shared
  secret, GitHub App private key, Supabase keys, AI-provider keys) live in
  environment variables only — never committed (enforced by `.gitignore`) and
  **never written to logs**.

## Tenant data isolation

Customer data is multi-tenant in one Postgres database; isolation is enforced at
the database, not just the application.

- **Row-Level Security (RLS) is enabled and org-scoped on every customer-data
  table** (ingested docs/chunks/embeddings, meetings, transcripts, captures,
  syntheses, knowledge gaps). Meeting content is further narrowed to actual
  **participants**, not just any org member.
- **Secret tables are service-role-only** (RLS enabled, no policies): token
  connections, install state, indexer cursors — members can never read them.
- **The server-derived org is the only source of truth.** Tenant-boundary
  decisions never trust a client-supplied org id; identifiers come from the
  authenticated session / verified JWT.
- **No over-broad client writes.** Privileged mutations (pin/dismiss, gap
  confirm/share, source config) go through org-checked service-role actions;
  there are no broad client `UPDATE` policies that a crafted request could abuse.
- Service-role queries that act on client-supplied ids re-assert `org_id`
  (defense-in-depth).

## Customer content protection

- **Sensitive meeting content is encrypted at rest** (pgcrypto AES-256,
  decrypted server-side only): the whole-meeting **recap**, the AI's
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
Anthropic for synthesis) under zero-retention terms. See
[`docs/security/sub-processors.md`](docs/security/sub-processors.md).

## Reporting a vulnerability

If you believe you've found a security vulnerability, please email
**security@onthecaseapps.com** with details and steps to reproduce. Please do
**not** open a public issue. We'll acknowledge receipt, investigate, and keep you
updated on remediation. We appreciate responsible disclosure and will credit
reporters who wish to be acknowledged.
