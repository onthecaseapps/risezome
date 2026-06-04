-- Per-org KMS key custody (security plan 003, U8; KTD2/KTD4).
--
-- Introduces the provisioning/revocation RECORD for per-org KMS CMKs and adds
-- the key-reference columns the per-org envelope scheme needs on tables that
-- lack them. The actual envelope crypto lives app-side in @risezome/crypto; the
-- DB only ever stores opaque ESDK ciphertext (bytea) — never a key, never
-- plaintext.

-- org_encryption_keys: one row per org recording its KMS CMK (arn + deterministic
-- alias) and lifecycle status. This is the provisioning/revocation record used in
-- prod ops and by the U11 migration; it is NOT on the key-resolution hot path —
-- the alias is derived deterministically in app code via aliasForOrg(org_id), so
-- decrypt never needs to read this table. status: 'active' | 'disabled' (instant
-- per-org revocation) | 'rotating'. kms_key_arn / kms_alias are null in the dev
-- RawAES fallback (RISEZOME_DEV_CRYPTO_KEY) where there is no AWS CMK.
create table public.org_encryption_keys (
  org_id      uuid        primary key references public.orgs(id) on delete cascade,
  kms_key_arn text,
  kms_alias   text,
  status      text        not null default 'active',
  created_at  timestamptz not null default now()
);

-- Service-role only: this table records key custody material and must never be
-- client-readable. RLS enabled with NO policies (mirrors the other secret tables:
-- atlassian_connections, trello_connections, user_google_tokens) — the
-- authenticated role gets zero rows; only the service-role (RLS-bypass) key, used
-- by provisioning + migration jobs, can read/write it.
alter table public.org_encryption_keys enable row level security;

-- --- key-reference columns on encrypted tables missing them --------------------

-- user_google_tokens has no org_id (tokens are per-user). The per-org scheme
-- encrypts the Google refresh token under the user's ORG-OF-RECORD (oldest
-- membership; KTD4). key_org_id records which org's key was used so decrypt can
-- resolve the right CMK. Nullable: legacy/pre-KMS rows have no key_org_id and are
-- backfilled by the U11 migration.
alter table public.user_google_tokens add column key_org_id uuid;

-- trello_connections currently has no version column. token_version marks the
-- crypto format of token_enc (1 = legacy pgcrypto, 2 = KMS-ESDK; see
-- @risezome/crypto CRYPTO_VERSION). Default 1 = legacy, so any pre-existing row
-- is treated as un-migrated until U11/U9 stamps it to 2.
alter table public.trello_connections add column token_version int not null default 1;

-- meeting_events.transcript_text_enc had no version marker. transcript_key_version
-- marks the format of transcript_text_enc (1 = legacy pgcrypto, 2 = KMS-ESDK).
-- Nullable: rows with no transcript text (non-transcript events) leave it null;
-- transcript rows get it stamped on write.
alter table public.meeting_events add column transcript_key_version int;
