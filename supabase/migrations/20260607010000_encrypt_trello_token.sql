-- Encrypt the Trello org token at rest (security U3 / S5). Mirrors the Atlassian
-- token encryption (20260607000000) and user_google_tokens: pgcrypto AES-256 via
-- public.encrypt_refresh_token / decrypt_refresh_token, keyed by
-- USER_TOKEN_ENCRYPTION_KEY which the DB never stores.
--
-- The Trello token is static (no rotation, expires_at is usually null), so no
-- token_version concurrency guard is needed — just the encrypted column.
--
-- Pre-launch: plaintext is not carried forward (fresh local stack has no rows);
-- any existing connection must re-connect.

alter table public.trello_connections add column token_enc bytea;
alter table public.trello_connections drop column token;

-- RLS unchanged: enabled with NO policies (service-role only).
