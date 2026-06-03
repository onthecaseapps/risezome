---
title: Customer-content encryption at rest — what we encrypt vs disk-only
date: 2026-06-03
tags: [security, encryption, data-at-rest, supabase]
type: architecture
---

# Customer-content encryption at rest

**Decision:** column-level encrypt the high-sensitivity content columns that are
**not searched and not on a hot write path**; for the rest, rely on
Supabase/Postgres **disk-level** encryption and record _why_ — so the residual is
a deliberate, documented choice rather than a silent gap. (Security plan KTD2 / U9.)

## What IS column-encrypted (pgcrypto AES-256, key = `USER_TOKEN_ENCRYPTION_KEY`)

- **Third-party OAuth tokens** — `user_google_tokens.refresh_token_enc`,
  `atlassian_connections.{access,refresh}_token_enc`, `trello_connections.token_enc`.
- **`meetings.recap_text_enc`** — the whole-meeting AI recap. Single write (one
  Claude call on `bot.call_ended`), single read (review page, decrypted
  server-side). Highest-sensitivity meeting artifact, no query/search over it.

These use the shared pgcrypto helpers `public.encrypt_refresh_token` /
`public.decrypt_refresh_token` (OpenPGP symmetric, `cipher-algo=aes256`). The key
lives only in env; the DB never stores it, so a dump/backup/replica yields only
ciphertext.

## What is disk-encryption-only, and why

| Column                                        | Why not column-encrypted                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meeting_events.payload` (transcripts, jsonb) | **Queried** via `payload->>'speaker'` in the `capture_card_stats` DB function. Column-encrypting to `bytea` would break that server-side aggregation. Needs a refactor (extract `speaker` to its own column) before the rest of the payload can be encrypted.                       |
| `syntheses.accumulated_text`                  | Written **incrementally on the live synthesis hot path** (bot-worker `retrieval.ts`): insert empty, then update with the streamed answer. Encrypting the hot path adds per-write crypto + decrypt to several read sites; deferred to avoid destabilizing the live meeting pipeline. |
| `doc_chunks.text`                             | Backs a **generated `tsvector` FTS index** and is the source for **HNSW vector search** — encrypting it breaks both.                                                                                                                                                                |
| `corpus_chunk_embeddings.embedding`           | A vector cannot be both encrypted and similarity-searchable.                                                                                                                                                                                                                        |

For these, the protections that DO apply: Supabase volume-level encryption
(protects stolen disks), strict RLS / participant scoping (members can't read
other tenants' rows), service-role-only secret tables, and the
purge-on-disconnect job (content doesn't linger after a source is removed).

## Residual risk

A leaked **service-role key** or a SQL-injection read against an app process
could still expose the disk-only columns in cleartext (the encrypted columns
would not, absent the env key). Closing that for transcripts/syntheses requires
the refactors above (extract searched fields; move the synthesis write off the
hot path) — tracked as follow-up, not done here.

## Follow-up

- Extract `meeting_events.payload->>'speaker'` (and any other queried field) into
  plaintext columns, then encrypt the remaining transcript body.
- Encrypt `syntheses.accumulated_text` once the write path can absorb the crypto.
- Envelope encryption / KMS for the master key (see `docs/runbooks/encryption-key-rotation.md`, U10).
