---
title: Customer-content encryption at rest — what we encrypt vs disk-only
date: 2026-06-03
tags: [security, encryption, data-at-rest, supabase]
type: architecture
---

# Customer-content encryption at rest

**Decision:** column-level encrypt the high-sensitivity content; for the few
columns that are queried or searched at the DB layer, rely on Supabase/Postgres
**disk-level** encryption and record _why_ — so the residual is a deliberate,
documented choice rather than a silent gap. (Security plan KTD2 / U9, extended by
F1 + F2.)

> **Update (plan `2026-06-03-003`):** the encryption *backend* moved from a single
> global pgcrypto key to **per-organization AWS KMS envelope encryption** (AWS
> Encryption SDK; AES-256-GCM app-side via `@risezome/crypto`). The *set* of
> encrypted columns below is unchanged; what changed is custody — each org has its
> own KMS CMK, crypto runs app-side so the DB never sees a key or plaintext, and a
> leaked key is capped to one org (addressing the app/key/insider threat). The
> pgcrypto SQL helpers are dropped after the one-time migration
> (`docs/runbooks/encryption-kms-migration.md`). References to
> `pgp_sym_encrypt` / `transcript_with_text` / `USER_TOKEN_ENCRYPTION_KEY` below
> describe the superseded scheme.

## What IS column-encrypted (now per-org AWS KMS envelope; formerly pgcrypto)

- **Third-party OAuth tokens** — `user_google_tokens.refresh_token_enc`,
  `atlassian_connections.{access,refresh}_token_enc`, `trello_connections.token_enc`.
- **`meetings.recap_text_enc`** (U9) — the whole-meeting AI recap. Single write
  (one Claude call on `bot.call_ended`), single read (review page, decrypted
  server-side).
- **`syntheses.accumulated_text_enc`** (F1) — the AI's grounded answers (reveal
  the question + quoted code/doc snippets). Encrypted on the `done` update;
  decrypted server-side on the review/live pages.
- **Meeting transcript text** — `meeting_events.transcript_text_enc` (F2). The
  verbatim spoken words are pulled out of `payload` and encrypted; **`speaker` /
  timing / `utteranceId` stay in `payload`** (plaintext) so `capture_card_stats`
  (which reads `payload->>'speaker'`) keeps working. Readers use the
  `transcript_with_text` RPC, which decrypts the whole transcript server-side in
  one round-trip (RLS still applies). The live broadcast still carries plaintext
  text to authorized participants in memory; only the stored copy is encrypted.

These use the shared pgcrypto helpers `public.encrypt_refresh_token` /
`public.decrypt_refresh_token` (OpenPGP symmetric, `cipher-algo=aes256`). The key
lives only in env; the DB never stores it, so a dump/backup/replica yields only
ciphertext. All are covered by the key-rotation re-wrap
(`docs/runbooks/encryption-key-rotation.md`).

## What is disk-encryption-only, and why

| Column                                                       | Why not column-encrypted                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meeting_events.payload` minus text (`speaker`, timing, ids) | Speaker names are **queried** via `payload->>'speaker'` (`capture_card_stats`). Lower-sensitivity metadata; the sensitive transcript **text** is encrypted separately (above). |
| `doc_chunks.text`                                            | Backs a **generated `tsvector` FTS index** and is the source for **HNSW vector search** — encrypting it breaks both.                                                           |
| `corpus_chunk_embeddings.embedding`                          | A vector cannot be both encrypted and similarity-searchable.                                                                                                                   |

For these, the protections that DO apply: Supabase volume-level encryption
(protects stolen disks), strict RLS / participant scoping (members can't read
other tenants' rows), service-role-only secret tables, and the
purge-on-disconnect job (content doesn't linger after a source is removed).

## Residual risk

A leaked **service-role key** or a SQL-injection read against an app process
could still expose the disk-only columns in cleartext (the encrypted columns
would not — their keys are custodied in per-org KMS, outside the app/DB). The
remaining disk-only customer content is the search corpus (`doc_chunks.text` +
embeddings), which can't be column-encrypted without losing FTS/vector search,
and speaker names. With per-org KMS, an app/key compromise or insider is capped
to one org for the encrypted columns; the disk-only corpus is the unchanged
residual (deferred — searchable encryption, below).

## Follow-up

- A searchable-encryption scheme for `doc_chunks.text` (e.g. deterministic
  encryption for exact-match terms, or client-side blind indexing) if the corpus
  cleartext residual needs closing — non-trivial, deferred.
- ~~Envelope encryption / KMS for the master key~~ — **done** (plan
  `2026-06-03-003`): per-org AWS KMS envelope encryption. See
  `docs/runbooks/encryption-key-rotation.md` and
  `docs/runbooks/encryption-kms-migration.md`.
