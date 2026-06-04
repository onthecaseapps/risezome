-- Decommission the legacy global-key pgcrypto crypto path (security plan 003,
-- U13; KTD3). Drops the OpenPGP/AES-256 SQL helpers and the global re-wrap
-- procedure that the per-org KMS envelope scheme (@risezome/crypto) supersedes.
-- After this migration the DB holds no crypto code and no key ever reaches the
-- DB server: all encrypt/decrypt happens app-side under per-org KMS CMKs.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ APPLY ONLY AFTER the U11 backfill has run and verified zero rows <        │
-- │ KMS_ESDK (see docs/runbooks/encryption-kms-migration.md). U11 decrypts    │
-- │ legacy rows THROUGH decrypt_refresh_token; dropping it before the backfill │
-- │ completes makes legacy ciphertext permanently unrecoverable. The          │
-- │ documented deploy sequence is:                                            │
-- │   1. apply the U8 schema migration (org_encryption_keys + key-ref cols)    │
-- │   2. deploy the U9/U10 cutover code (reads/writes KMS-ESDK only)           │
-- │   3. run the U11 backfill (risezome/encryption.migrate-to-kms)            │
-- │   4. verify zero rows remain < KMS_ESDK (verification queries in runbook)  │
-- │   5. apply THIS migration                                                  │
-- └─────────────────────────────────────────────────────────────────────────┘

-- The bulk-decrypt RPC the transcript reader used (replaced app-side in U10).
drop function if exists public.transcript_with_text(uuid, uuid, text);

-- The global key-rotation re-wrap procedure (superseded by per-org rotation in
-- U12: apps/portal/src/inngest/functions/rotate-org-key.ts).
drop function if exists public.rewrap_encrypted_secrets(text, text);

-- The generic pgcrypto encrypt/decrypt helpers keyed by USER_TOKEN_ENCRYPTION_KEY.
drop function if exists public.encrypt_refresh_token(text, text);
drop function if exists public.decrypt_refresh_token(bytea, text);
