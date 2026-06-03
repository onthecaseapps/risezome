-- Encrypt Atlassian access + refresh tokens at rest (security U2 / S2).
--
-- Mirrors user_google_tokens (20260530100000): pgcrypto pgp_sym_encrypt
-- (AES-256) via the generic public.encrypt_refresh_token /
-- public.decrypt_refresh_token helpers, keyed by USER_TOKEN_ENCRYPTION_KEY which
-- the app supplies at call time. The DB never stores the key, so a dump/backup/
-- replica of this table yields only ciphertext.
--
-- token_version replaces the previous refresh-token-equality concurrency guard
-- in atlassian-token.ts: pgp_sym_encrypt is non-deterministic (random session
-- key per call), so two encryptions of the same plaintext differ and ciphertext
-- can't be compared with `.eq(refresh_token, ...)`. The guarded update now
-- matches on token_version and bumps it on each rotation.
--
-- Pre-launch: we do NOT carry plaintext forward. The plaintext columns are
-- dropped; any existing connection (there are none in a fresh local stack) must
-- re-auth — the app treats a missing/undecryptable token as "reconnect".

alter table public.atlassian_connections
  add column access_token_enc  bytea,
  add column refresh_token_enc bytea,
  add column token_version     integer not null default 0;

alter table public.atlassian_connections
  drop column access_token,
  drop column refresh_token;

-- RLS unchanged: enabled with NO policies (service-role only). The tokens stay
-- unreadable by members; they are now also encrypted at rest.
