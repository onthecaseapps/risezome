-- U2: Persistent storage for the user's Google OAuth refresh token so the
-- portal + Inngest functions can refresh the access token offline (e.g., for
-- calendar push channel renewal) without re-prompting the user.
--
-- The refresh token is encrypted at rest via pgcrypto's pgp_sym_encrypt. The
-- encryption key is a server-side env var (USER_TOKEN_ENCRYPTION_KEY)
-- supplied at call time; the DB never stores or knows the key. A Supabase
-- DB dump alone is useless without the env key.
--
-- Why not Supabase Vault: Vault is in beta as of 2026 and has reported
-- flakiness around RLS interaction + revocation flows. pgcrypto is a
-- conservative choice that works identically on Free and Pro tiers. Swap
-- to Vault later if its maturity catches up.
--
-- Access tokens are short-lived (~1h) and stored as plaintext text — the
-- threat model is "a DB compromise during a one-hour window is bounded";
-- the long-lived refresh token is the real keys-to-the-kingdom.

create extension if not exists pgcrypto with schema extensions;

create table public.user_google_tokens (
  user_id              uuid        primary key references auth.users(id) on delete cascade,
  access_token         text        not null,
  refresh_token_enc    bytea       not null,
  expires_at           timestamptz not null,
  scope                text,
  updated_at           timestamptz not null default now()
);

alter table public.user_google_tokens enable row level security;

-- A user can read their own row (for debugging visibility in Server
-- Components running with the user's JWT). Writes happen exclusively
-- through trusted server contexts using the service-role key.
create policy "users read their own google tokens"
  on public.user_google_tokens for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Helpers for encrypt/decrypt — application layer passes the symmetric key
-- as a parameter every time. SECURITY INVOKER so the policies on the
-- caller's role still apply (the caller decides whether they can even
-- read the row first; these functions just transform the bytes).
create or replace function public.encrypt_refresh_token(
  plaintext text,
  key       text
) returns bytea
language sql
immutable
security invoker
as $$
  select extensions.pgp_sym_encrypt(plaintext, key, 'compress-algo=2, cipher-algo=aes256')
$$;

create or replace function public.decrypt_refresh_token(
  ciphertext bytea,
  key        text
) returns text
language sql
immutable
security invoker
as $$
  select extensions.pgp_sym_decrypt(ciphertext, key)
$$;
