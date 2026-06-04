# @risezome/crypto

Shared per-org **envelope encryption**, consumed identically by `apps/portal`
and `apps/bot-worker` so the portal↔bot-worker key-equality invariant holds: a
ciphertext written by one surface decrypts on the other.

One implementation, one format. Crypto happens app-side via the AWS Encryption
SDK for JavaScript (`@aws-crypto/client-node`): the SDK generates/wraps a data
key with the org's per-org KMS CMK, performs AES-256-GCM in `node:crypto`, and
emits a self-describing message that embeds the wrapped data key. The DB only
ever stores those opaque ciphertext bytes (`bytea`) — no IVs/tags/DEKs are
hand-managed, and no plaintext key ever reaches the DB server.

## Layout

```
src/
├── envelope.ts   # the whole implementation: keyring selection (KMS vs dev),
│                 # caching CMM, encrypt/decrypt, bytea bridge helpers
└── index.ts      # public barrel (production API only)
```

## Public API

```ts
import {
  encryptForOrg, // (orgId, plaintext) -> Promise<Buffer>  (raw ESDK bytes)
  decryptForOrg, // (orgId, ciphertext) -> Promise<string>
  encryptForOrgToBytea, // (orgId, plaintext) -> Promise<string>  (bytea \x<hex> to store)
  decryptForOrgFromBytea, // (orgId, value) -> Promise<string>      (decode + decrypt a read)
  byteaToHex,
  hexToBuffer, // bytea <-> Buffer bridge (supabase-js/PostgREST)
  aliasForOrg, // (orgId) -> deterministic KMS alias string
  CRYPTO_VERSION, // { LEGACY_PGCRYPTO: 1, KMS_ESDK: 2 } row-version sentinels
  EnvelopeCryptoError, // typed failure (cause preserved) for graceful degradation
} from '@risezome/crypto';
```

`supabase-js` does **not** accept a Node `Buffer` for a `bytea` column (it
JSON-mangles it). Always write the `\x<hex>` text form via `encryptForOrgToBytea`
/ `byteaToHex`, and decode reads via `decryptForOrgFromBytea` / `hexToBuffer`.

## Required environment

Read at call time, never hardcoded:

| Var                                                                 | When              | Purpose                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AWS_REGION`                                                        | production        | Region of the per-org CMKs (standard AWS env var).                                                                                                                                                                                                                                                           |
| `KMS_ALIAS_PREFIX`                                                  | optional          | Alias namespace prefix; defaults to `risezome`.                                                                                                                                                                                                                                                              |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` | production        | Standard AWS credential chain used by the KMS keyring (or an instance/role provider).                                                                                                                                                                                                                        |
| `RISEZOME_DEV_CRYPTO_KEY`                                           | **dev / CI ONLY** | When set, selects a local `RawAES` fallback (per-org key = `HKDF(secret, org_id)`) instead of KMS, so dev and CI run with no AWS access. **Production must NOT set this** — the default keyring provider **fails closed** and throws `EnvelopeCryptoError` if `NODE_ENV==='production'` and this var is set. |

## Test-injection hook

`__setKeyringProviderForTests(fn | null)` is exported **only** from
`./envelope.js` (not the public barrel). Tests pass a `RawAesKeyringNode` per
org so the suite exercises the real ESDK message format, encryptionContext
binding, and caching CMM with no AWS network; pass `null` to restore the
production keyring path. Setting/resetting clears the per-org CMM memo.

## Notes

- `REQUIRE_ENCRYPT_REQUIRE_DECRYPT` commitment policy: every message commits to
  its data key and we refuse to read non-committing messages.
- The per-org caching CMM (`NodeCachingMaterialsManager`) collapses KMS
  `GenerateDataKey` traffic to roughly one call per (org, bound-window) on the
  transcript hot path. The per-org CMM memo is a bounded LRU (cap 512) — a pure
  perf cache, safe to evict.
