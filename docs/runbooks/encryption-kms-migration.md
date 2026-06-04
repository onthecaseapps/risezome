# One-time encryption migration: global pgcrypto → per-org KMS envelope

This is the **one-time backfill** (security plan 003, U11; KTD7) that re-encrypts
all existing ciphertext from the legacy global `USER_TOKEN_ENCRYPTION_KEY`
pgcrypto format into the per-org AWS KMS envelope format (`@risezome/crypto`,
`CRYPTO_VERSION.KMS_ESDK = 2`). It runs **once per environment** as part of the
cutover deploy. For ongoing rotation/revocation see
[`encryption-key-rotation.md`](./encryption-key-rotation.md).

## Why ordering matters

The cutover code (U9 encrypt sites, U10 decrypt sites) reads and writes **only**
the new KMS-ESDK format. On an environment with existing legacy rows, those rows
are unreadable by the new code until this backfill converts them. And the backfill
itself **decrypts legacy rows through the pgcrypto helper**
`public.decrypt_refresh_token` + the global key — so those helpers must still be
present while it runs. Hence the strict sequence below; getting it wrong risks
unreadable data.

## Deploy sequence (do these in order)

1. **Apply the U8 schema migration** — `org_encryption_keys` table + the key-ref
   columns (`user_google_tokens.key_org_id`, `trello_connections.token_version`,
   `meeting_events.transcript_key_version`). Migration
   `20260607090000_org_encryption_keys.sql`.
2. **Deploy the U9/U10 cutover code** — portal + bot-worker now encrypt/decrypt
   via `@risezome/crypto` and stamp `*_version = KMS_ESDK` on new writes. Set the
   production crypto env: `AWS_REGION`, `KMS_ALIAS_PREFIX`, and the AWS credential
   chain. Do **not** set `RISEZOME_DEV_CRYPTO_KEY` in production. Keep
   `USER_TOKEN_ENCRYPTION_KEY` set — the backfill still needs it (step 3).
3. **Run the U11 backfill.** Trigger the Inngest function
   `risezome/encryption.migrate-to-kms`:

   ```jsonc
   // all orgs:
   { "name": "risezome/encryption.migrate-to-kms", "data": {} }
   // a single org (smoke-test first):
   { "name": "risezome/encryption.migrate-to-kms", "data": { "orgId": "<org-uuid>" } }
   ```

   Per org it ensures the org's CMK exists (idempotent `provisionOrgKey`), then
   for each encrypted column decrypts every legacy row via
   `decrypt_refresh_token` + `USER_TOKEN_ENCRYPTION_KEY`, re-encrypts via
   `encryptForOrgToBytea(orgId, …)`, writes the new ciphertext, and stamps
   `*_version = KMS_ESDK`. It returns per-column `{ scanned, migrated, skipped }`
   counts. Implementation:
   `apps/portal/src/inngest/functions/migrate-encryption-to-kms.ts`
   (`migrateOrgEncryption`).
4. **Verify zero rows remain on the old version** (queries below). The count must
   be **0** for every column before proceeding.
5. **Apply the U13 drop migration** — `20260608000000_drop_pgcrypto_secret_helpers.sql`
   drops the pgcrypto helpers + `rewrap_encrypted_secrets`. Only after this is it
   safe to remove `USER_TOKEN_ENCRYPTION_KEY` from the environment.

## Idempotency, resumability, stragglers

- **Idempotent / resumable:** the per-row `*_version` columns are the progress
  marker. A row already at `KMS_ESDK` is skipped, so re-sending the event (or
  resuming after an interruption) never double-encrypts and never skips a row.
- **Atlassian rows** are special: `atlassian_connections.token_version` is an
  optimistic-concurrency counter (it increments on every token refresh), **not** a
  crypto-format marker, so it can't say "legacy" the way the other version columns
  do. The backfill instead **probes**: it attempts an ESDK decrypt of the access
  ciphertext; success ⇒ already KMS (skip), `EnvelopeCryptoError` ⇒ legacy
  pgcrypto bytes (migrate). The OC counter is left untouched so concurrent
  rotation guards keep working.
- **Google tokens** have no `org_id` — each is migrated under the user's
  **org-of-record** (oldest membership, KTD4), and `key_org_id` is set so decrypt
  can resolve the right CMK. A user is migrated only while processing their
  org-of-record, so a multi-org user's token is re-encrypted exactly once.
- **Mid-migration write race (KTD7):** a write landing under the old key after a
  column's pass is a straggler the next pass catches — the version filter
  re-surfaces it. After step 4 reports zero, a final re-run confirms quiescence.

## Verification queries

All counts must be **0** before applying the U13 drop migration. Run as
service-role/operator (psql or `supabase db`):

```sql
-- KMS_ESDK = 2. 0 and 1 both mean "legacy pgcrypto".
select 'meetings.recap_text_enc' as col, count(*) as legacy
  from public.meetings
  where recap_text_enc is not null and coalesce(recap_key_version, 0) < 2
union all
select 'syntheses.accumulated_text_enc', count(*)
  from public.syntheses
  where accumulated_text_enc is not null and coalesce(synth_key_version, 0) < 2
union all
select 'meeting_events.transcript_text_enc', count(*)
  from public.meeting_events
  where transcript_text_enc is not null and coalesce(transcript_key_version, 0) < 2
union all
select 'trello_connections.token_enc', count(*)
  from public.trello_connections
  where token_enc is not null and coalesce(token_version, 0) < 2
union all
select 'user_google_tokens.refresh_token_enc', count(*)
  from public.user_google_tokens
  where refresh_token_enc is not null
    and (coalesce(key_version, 0) < 2 or key_org_id is null);
```

Atlassian rows carry no version sentinel, so verify them by decrypt: every
`atlassian_connections` row must decrypt under its org's KMS key. The simplest
operational check is to exercise a connector refresh per connected org (or re-run
the backfill for an org and confirm `migrated = 0` on the atlassian line).

## Rollback

Before step 5 (the drop migration) the legacy helpers and the global key are
still present, so rollback is clean: redeploy the **pre-cutover** code, which
reads the legacy format. Rows already migrated to KMS-ESDK would then be
unreadable by the old code — so only roll back if the backfill has **not** yet
run against production data, or restore from a pre-migration snapshot. Once step 5
has dropped the pgcrypto helpers, there is no legacy decrypt path: rollback then
requires restoring the helpers (re-create the dropped functions) **and** the
global key, or a snapshot restore. Keep a documented snapshot/backup taken
immediately before step 3.
