# Rotating `USER_TOKEN_ENCRYPTION_KEY`

The symmetric key in `USER_TOKEN_ENCRYPTION_KEY` protects every column-encrypted
secret at rest (Google/Atlassian/Trello tokens, meeting recaps). Rotating it
**re-wraps** each ciphertext — decrypt with the old key, re-encrypt with the new
key — so no user has to re-authenticate. The key never lands in the database;
both keys are passed transiently to a one-shot SQL function.

> **Industry-standard crypto only (KTD1).** Rotation uses the vetted pgcrypto
> OpenPGP/AES-256 primitives via `public.rewrap_encrypted_secrets`. We never
> implement key wrapping by hand.

## What gets re-wrapped

`public.rewrap_encrypted_secrets(old_key, new_key)` re-encrypts, in one
transaction, every encrypted column and bumps its per-row version:

- `user_google_tokens.refresh_token_enc` (+ `key_version`)
- `atlassian_connections.access_token_enc` / `refresh_token_enc` (+ `token_version`)
- `trello_connections.token_enc`
- `meetings.recap_text_enc` (+ `recap_key_version`)

## Procedure (maintenance window)

1. **Generate a new key** (keep it secret; do not commit it):

   ```bash
   openssl rand -base64 48
   ```

2. **Re-wrap the data** with both keys, supplied transiently. Run as the
   service-role/operator against the target DB (psql, or `supabase db` against
   the linked project). **Do not write the keys into a committed file.**

   ```sql
   -- OLD and NEW are the current and new key values.
   select * from public.rewrap_encrypted_secrets('OLD', 'NEW');
   ```

   The result lists rows re-wrapped per table. Zero rows for an empty table is
   fine.

3. **Point the app at the new key.** Update `USER_TOKEN_ENCRYPTION_KEY` (and the
   matching value in the bot-worker env — it must equal the portal's) to `NEW`
   in your secret store / deployment env, then redeploy/restart portal +
   bot-worker.

4. **Verify.** Exercise a decrypt path (e.g. open a meeting review page so the
   recap decrypts, or trigger a connector refresh). A decrypt failure means the
   app is still using the old key — recheck step 3.

5. **Retire the old key** once you've confirmed the app reads cleanly under the
   new key.

## Rollback

If something is wrong before you've discarded the old key, re-wrap back:

```sql
select * from public.rewrap_encrypted_secrets('NEW', 'OLD');
```

then revert the env to `OLD` and redeploy.

## Notes & future

- Run during low traffic: a token refresh that writes mid-rotation could be
  encrypted under the old key after the re-wrap pass; the verify step (and a
  second re-wrap if needed) catches stragglers. The per-row version columns let
  you detect rows still on the old version.
- **Production key hygiene:** the production `USER_TOKEN_ENCRYPTION_KEY` must be
  distinct from any value present in developer `.env` files (see
  `docs/runbooks/two-developer-local-setup.md`).
- **Deferred — envelope encryption / KMS.** The long-term upgrade is a
  KMS-backed envelope key (AWS KMS / GCP KMS / Supabase Vault when its
  RLS/revocation maturity allows), so the master key isn't a static env string.
  The `key_version` columns make that migration non-breaking.
