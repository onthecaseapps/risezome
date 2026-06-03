-- Encryption-key rotation support (security U10 / S10).
--
-- The single static USER_TOKEN_ENCRYPTION_KEY protects every column-encrypted
-- secret. To rotate it without forcing every user to re-auth, we re-wrap each
-- ciphertext: decrypt with the OLD key, re-encrypt with the NEW key, bump the
-- per-row version. This function performs the re-wrap across all encrypted
-- columns in one transaction. Run it during a maintenance window (see
-- docs/runbooks/encryption-key-rotation.md); then point the app at the new key.
--
-- Uses only the vetted pgcrypto primitives (OpenPGP/AES-256, KTD1). SECURITY
-- INVOKER + revoked from anon/authenticated so only the service-role/operator
-- can run it — the keys are passed transiently and never stored.

-- Give user_google_tokens a key_version for parity with the other encrypted
-- tables (and so rotation is trackable per row).
alter table public.user_google_tokens
  add column if not exists key_version integer not null default 0;

create or replace function public.rewrap_encrypted_secrets(old_key text, new_key text)
returns table (table_name text, rows_rewrapped bigint)
language plpgsql
security invoker
as $$
declare
  algo constant text := 'compress-algo=2, cipher-algo=aes256';
  n bigint;
begin
  update public.user_google_tokens
    set refresh_token_enc =
          extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(refresh_token_enc, old_key), new_key, algo),
        key_version = key_version + 1
    where refresh_token_enc is not null;
  get diagnostics n = row_count;
  table_name := 'user_google_tokens'; rows_rewrapped := n; return next;

  update public.atlassian_connections
    set access_token_enc = case when access_token_enc is not null
          then extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(access_token_enc, old_key), new_key, algo) end,
        refresh_token_enc = case when refresh_token_enc is not null
          then extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(refresh_token_enc, old_key), new_key, algo) end,
        token_version = token_version + 1
    where access_token_enc is not null or refresh_token_enc is not null;
  get diagnostics n = row_count;
  table_name := 'atlassian_connections'; rows_rewrapped := n; return next;

  update public.trello_connections
    set token_enc =
          extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(token_enc, old_key), new_key, algo)
    where token_enc is not null;
  get diagnostics n = row_count;
  table_name := 'trello_connections'; rows_rewrapped := n; return next;

  update public.meetings
    set recap_text_enc =
          extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(recap_text_enc, old_key), new_key, algo),
        recap_key_version = recap_key_version + 1
    where recap_text_enc is not null;
  get diagnostics n = row_count;
  table_name := 'meetings'; rows_rewrapped := n; return next;
end;
$$;

revoke all on function public.rewrap_encrypted_secrets(text, text) from public, anon, authenticated;
grant execute on function public.rewrap_encrypted_secrets(text, text) to service_role;
