-- Extend the key-rotation re-wrap (U10) to cover the newly-encrypted content
-- columns: syntheses.accumulated_text_enc (F1) and meeting_events.transcript_text_enc
-- (F2). Re-creates public.rewrap_encrypted_secrets with the full set so a single
-- rotation pass covers every encrypted column. Same contract as before
-- (SECURITY INVOKER, service-role only, vetted pgcrypto only — KTD1).

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

  update public.syntheses
    set accumulated_text_enc =
          extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(accumulated_text_enc, old_key), new_key, algo),
        synth_key_version = synth_key_version + 1
    where accumulated_text_enc is not null;
  get diagnostics n = row_count;
  table_name := 'syntheses'; rows_rewrapped := n; return next;

  update public.meeting_events
    set transcript_text_enc =
          extensions.pgp_sym_encrypt(extensions.pgp_sym_decrypt(transcript_text_enc, old_key), new_key, algo)
    where transcript_text_enc is not null;
  get diagnostics n = row_count;
  table_name := 'meeting_events'; rows_rewrapped := n; return next;
end;
$$;

revoke all on function public.rewrap_encrypted_secrets(text, text) from public, anon, authenticated;
grant execute on function public.rewrap_encrypted_secrets(text, text) to service_role;
