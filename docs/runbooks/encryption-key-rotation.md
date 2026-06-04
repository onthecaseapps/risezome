# Per-org key rotation & revocation (AWS KMS envelope)

> This supersedes the old global `USER_TOKEN_ENCRYPTION_KEY` re-wrap procedure.
> Crypto is now **per-org AWS KMS envelope encryption** (`@risezome/crypto`,
> security plan 003, KTD1/KTD2). Each org has its own Customer Master Key (CMK),
> addressed by the deterministic alias `alias/<KMS_ALIAS_PREFIX>-org-<orgId>`. The
> database stores only opaque AWS Encryption SDK ciphertext (bytea) — no key, no
> plaintext, and the global `rewrap_encrypted_secrets` SQL procedure is **removed**
> (security plan 003, U13). Rotation and revocation are now per-org and isolated:
> one org's operation never touches another org's data.

## What's encrypted (per-org)

Every encrypted column is wrapped under the owning org's CMK:

- `user_google_tokens.refresh_token_enc` (+ `key_version`, `key_org_id` = org-of-record)
- `atlassian_connections.access_token_enc` / `refresh_token_enc` (+ `token_version` — an
  optimistic-concurrency counter, **not** a crypto-format marker)
- `trello_connections.token_enc` (+ `token_version`)
- `meetings.recap_text_enc` (+ `recap_key_version`)
- `syntheses.accumulated_text_enc` (+ `synth_key_version`)
- `meeting_events.transcript_text_enc` (+ `transcript_key_version`)

The provisioning/lifecycle record for each org's CMK lives in
`public.org_encryption_keys` (`status`: `active` | `rotating` | `revoked`).

## 1. CMK rotation (automatic — nothing to run)

The KMS CMK's wrapping material rotates automatically when AWS KMS **annual key
rotation** is enabled on the key (set at provisioning time / in Terraform). This
rotates the wrapping key **with no data rewrite**: KMS keeps prior key material so
existing ciphertext stays decryptable, and new writes use the new material. This
is the default, ongoing rotation story and requires no app action.

## 2. Per-org data-key re-encryption (explicit re-key)

When you want every ciphertext for an org freshly wrapped under a new data key
(e.g. after a suspected data-key exposure, or to fully cycle an org after a CMK
rotation), run the per-org rotation job. It decrypts each of the org's rows via
`@risezome/crypto` and re-encrypts under a fresh data key — strictly scoped to
that one org; no other org's bytes are read or written.

Trigger the Inngest function `risezome/encryption.rotate-org-key`:

```jsonc
// event payload
{ "name": "risezome/encryption.rotate-org-key", "data": { "orgId": "<org-uuid>" } }
```

It returns per-column counts of rows rotated. Idempotent and re-runnable (a
re-run simply re-wraps again). Run during low traffic; a token refresh that lands
mid-pass is already KMS-format, so it stays decryptable — re-running the job
re-wraps it under the newest data key.

Implementation: `apps/portal/src/inngest/functions/rotate-org-key.ts`
(`rotateOrgKey`).

## 3. Instant revocation (disable an org's CMK)

To make a single org's data **immediately unreadable** (compromise, offboarding,
legal hold):

1. **Disable the CMK in AWS KMS** for that org (console or
   `aws kms disable-key --key-id alias/<KMS_ALIAS_PREFIX>-org-<orgId>`). This is
   the real, instant revocation: with the CMK disabled, KMS refuses to unwrap the
   org's data keys, so **every decrypt for that org throws** — its tokens,
   recaps, syntheses, and transcripts become cryptographically unreadable. No
   other org is affected (per-org CMK isolation, KTD2).
2. **Record it** by marking the org's key revoked (operational record + signal to
   ops tooling): trigger the same rotation function in revoke mode —

   ```jsonc
   { "name": "risezome/encryption.rotate-org-key",
     "data": { "orgId": "<org-uuid>", "mode": "revoke" } }
   ```

   which sets `org_encryption_keys.status = 'revoked'` (see
   `disableOrgKey`). Note: this DB flag alone does **not** revoke access — the
   ciphertext is only unreadable once the CMK itself is disabled in step 1.

**Re-enable** restores access: `aws kms enable-key ...` makes the org's data
decryptable again (the caching CMM in `@risezome/crypto` clears stale data keys
within its `maxAge` of 5 minutes, so a freshly enabled key takes effect promptly).

## Notes

- **No global re-key exists anymore.** A blast-radius event is contained to one
  org's CMK; there is no single key whose compromise affects all orgs.
- **`rewrap_encrypted_secrets` is gone** (dropped in U13's
  `drop_pgcrypto_secret_helpers.sql`). Do not look for it.
- **Production hygiene:** production must NOT set `RISEZOME_DEV_CRYPTO_KEY` (it
  selects the local non-KMS RawAES fallback). Production crypto requires
  `AWS_REGION` + the standard AWS credential chain and the per-org CMKs.
- The one-time legacy → KMS migration is a separate procedure — see
  [`encryption-kms-migration.md`](./encryption-kms-migration.md).
