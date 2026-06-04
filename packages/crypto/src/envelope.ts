// @risezome/crypto — shared envelope-crypto module (plan 002/003, U7; KTD1/2/6/7).
//
// One implementation of per-org envelope encryption, consumed identically by
// apps/portal and apps/bot-worker, so the portal↔bot-worker key-equality
// invariant (KTD6) holds: a ciphertext written by one surface decrypts on the
// other. Crypto happens app-side via the AWS Encryption SDK for JavaScript
// (`@aws-crypto/client-node`): the SDK generates/wraps a data key with the
// per-org KMS CMK, performs AES-256-GCM in node:crypto, and emits a
// self-describing message that embeds the wrapped data key. The DB only ever
// stores those opaque ciphertext bytes (bytea) — no IVs/tags/DEKs are
// hand-managed, and no plaintext key ever reaches the DB server (KTD3).
//
// Per-org CMK addressing (KTD2): the wrapping key for an org is the KMS alias
//   alias/${KMS_ALIAS_PREFIX}-org-<orgId>
// so a compromised data-key/CMK is capped to a single org. encryptionContext
// `{ org_id }` is additionally bound as defense-in-depth.
//
// Required runtime environment variables (read at call time — never hardcoded):
//   AWS_REGION         — AWS region of the per-org CMKs (standard AWS env var).
//   KMS_ALIAS_PREFIX   — alias namespace prefix; defaults to "risezome".
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (or an
//     instance/role credential provider) — standard AWS SDK credential chain,
//     used by the KMS keyring. Not read directly here.
//   RISEZOME_DEV_CRYPTO_KEY — DEV/CI ONLY. When set, selects a local RawAES
//     fallback (per-org key = HKDF(secret, org_id)) instead of KMS, so local dev
//     and CI run without AWS access. Production must NOT set this.

import {
  buildClient,
  CommitmentPolicy,
  KmsKeyringNode,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
  NodeCachingMaterialsManager,
  getLocalCryptographicMaterialsCache,
  type KeyringNode,
} from '@aws-crypto/client-node';
import { hkdfSync } from 'node:crypto';

// REQUIRE_ENCRYPT_REQUIRE_DECRYPT: every message commits to its data key and we
// refuse to read non-committing messages. Correct default for new data.
const { encrypt, decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

const ENC_CONTEXT_ORG_KEY = 'org_id';

/**
 * Per-row `*_version` sentinels marking which crypto format a `*_enc` column
 * holds. Defined once here and shared by every encrypt site (U9 stamps it) and
 * the re-encryption migration (U11 selects rows still on LEGACY_PGCRYPTO):
 *
 *   LEGACY_PGCRYPTO (1) — pgcrypto OpenPGP packet under the global
 *     USER_TOKEN_ENCRYPTION_KEY (pre-KMS). IMPORTANT: real pre-migration rows
 *     actually default to 0 on disk, NOT 1 — the original F1/F2 migrations
 *     declared these version columns `default 0`. The constant is named
 *     LEGACY_PGCRYPTO=1 only as a human label; in practice "legacy" means any
 *     value `< KMS_ESDK` (i.e. both 0 and 1), and U11 migrates anything that
 *     matches `.lt(versionColumn, KMS_ESDK)`. Do NOT rely on a column literally
 *     equalling 1 to detect legacy rows — use the `< KMS_ESDK` predicate.
 *   KMS_ESDK (2)        — AWS Encryption SDK message bytes, wrapped by the
 *     per-org KMS CMK (or the dev RawAES fallback). What every new write stamps.
 */
export const CRYPTO_VERSION = {
  LEGACY_PGCRYPTO: 1,
  KMS_ESDK: 2,
} as const;

/** Typed error so callers can distinguish crypto failures (e.g. KMS down,
 *  enc-context mismatch) from ordinary errors and decide on degradation.
 *  KMS errors are wrapped (cause preserved), never swallowed. */
export class EnvelopeCryptoError extends Error {
  override readonly name = 'EnvelopeCryptoError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
  }
}

/**
 * Deterministic per-org KMS alias. The alias is the addressing scheme for the
 * org's CMK (KTD2); it is created lazily at org provisioning (U8) and is stable
 * for the life of the org.
 */
export function aliasForOrg(orgId: string): string {
  const prefix = process.env.KMS_ALIAS_PREFIX ?? 'risezome';
  return `alias/${prefix}-org-${orgId}`;
}

// --- Keyring provider injection (for tests; production default is KMS) --------

type KeyringProvider = (orgId: string) => KeyringNode;

/**
 * Local-fallback keyring for dev / CI where there is no AWS KMS access. Derives
 * a deterministic per-org 32-byte AES key from the `RISEZOME_DEV_CRYPTO_KEY`
 * secret via HKDF-SHA256 (org_id as the info parameter), so different orgs get
 * different wrapping keys — the same per-org isolation property KMS provides,
 * minus the out-of-process custody. node:crypto HKDF + the ESDK RawAES keyring
 * are vetted primitives (KTD1 — no rolled crypto). NEVER used in production: the
 * provider only selects this path when RISEZOME_DEV_CRYPTO_KEY is set, which prod
 * must not set (deploy hygiene, mirroring the USER_TOKEN_ENCRYPTION_KEY rule).
 */
function devKeyringForOrg(orgId: string, devSecret: string): KeyringNode {
  const keyBytes = hkdfSync(
    'sha256',
    Buffer.from(devSecret),
    Buffer.alloc(0),
    Buffer.from(`org:${orgId}`),
    32,
  );
  return new RawAesKeyringNode({
    keyNamespace: 'risezome-dev',
    keyName: aliasForOrg(orgId),
    unencryptedMasterKey: new Uint8Array(keyBytes),
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
}

/**
 * Production keyring: a KmsKeyringNode whose generator (and only) key is the
 * org's per-org CMK alias. Region comes from the standard AWS_REGION env var,
 * consumed by the KMS client the keyring builds internally.
 *
 * Backend selection: if `RISEZOME_DEV_CRYPTO_KEY` is set we use the local
 * RawAES fallback (dev/CI explicitly opt in); otherwise KMS (production default,
 * requires AWS_REGION + the standard AWS credential chain). Production must never
 * set RISEZOME_DEV_CRYPTO_KEY.
 */
const defaultKeyringProvider: KeyringProvider = (orgId) => {
  const devSecret = process.env.RISEZOME_DEV_CRYPTO_KEY;
  if (devSecret !== undefined && devSecret.length > 0) {
    // Fail closed: the dev RawAES fallback must NEVER run in production. If a
    // prod deploy accidentally carries RISEZOME_DEV_CRYPTO_KEY we refuse to use
    // it (silently encrypting prod data under a non-KMS, env-derived key would
    // be a catastrophic custody downgrade) and surface a typed error instead.
    if (process.env.NODE_ENV === 'production') {
      throw new EnvelopeCryptoError(
        'refusing dev crypto fallback in production: RISEZOME_DEV_CRYPTO_KEY is set with NODE_ENV=production',
      );
    }
    return devKeyringForOrg(orgId, devSecret);
  }
  return new KmsKeyringNode({ generatorKeyId: aliasForOrg(orgId) });
};

let keyringProvider: KeyringProvider = defaultKeyringProvider;

/**
 * Inject the keyring provider, swapping the wrapping-key source only (the rest
 * of the pipeline — ESDK message format, encryptionContext binding, caching CMM
 * — stays real). Tests pass a RawAesKeyringNode per org so the suite runs with
 * no AWS network. Pass `null` to restore the production KmsKeyringNode path.
 * Resetting/setting clears the per-org CMM memo so the new keyring takes effect.
 */
export function __setKeyringProviderForTests(fn: KeyringProvider | null): void {
  keyringProvider = fn ?? defaultKeyringProvider;
  cmmByOrg.clear();
}

// --- Caching CMM, one per org (KTD7 / R10) ------------------------------------
//
// The bot-worker transcript hot path encrypts one message at a time and must
// NOT call KMS GenerateDataKey per message. We wrap each org's keyring in a
// NodeCachingMaterialsManager backed by a local materials cache so a data key
// is reused across many encrypts within the configured bounds, collapsing KMS
// traffic to roughly one call per (org, bound-window).
//
// One CMM per orgId (memoized below) means each org's data keys cache in their
// own partition and never cross orgs — the simplest correct design. We also
// give each CMM its own small local cache so eviction is per-org.
//
// Cache-bound rationale:
//   maxAge (5 min)          — cap wall-clock lifetime of a cached data key, so
//                             a disabled/rotated CMK (per-org revocation, KTD2)
//                             takes effect promptly; short enough to bound blast
//                             radius, long enough to amortize KMS across a burst.
//   maxMessagesEncrypted    — cap reuse count of a single data key (1000) to
//                             stay well within AES-GCM safe-use limits and bound
//                             exposure if one data key leaks.
//   maxBytesEncrypted       — secondary cap on bytes under one data key (~100MB)
//                             for large transcript payloads.
//   cache capacity (100)    — entries the local cache holds; one org typically
//                             uses one live entry, so 100 comfortably covers
//                             concurrent algorithm-suite/context variants.

const CMM_MAX_AGE_MS = 5 * 60 * 1000; // 300_000
const CMM_MAX_MESSAGES_ENCRYPTED = 1000;
const CMM_MAX_BYTES_ENCRYPTED = 100 * 1024 * 1024; // ~100 MiB
const CMM_CACHE_CAPACITY = 100;

// Cap the number of per-org CMMs held in memory. The CMM memo is a PURE perf
// cache (it only avoids rebuilding the keyring + local materials cache for a hot
// org); evicting an entry is always safe — the next encrypt/decrypt for that org
// simply rebuilds it. Without a cap this Map grew once per distinct org for the
// process lifetime (a slow unbounded leak on a long-lived bot-worker / Inngest
// process serving many orgs). 512 comfortably covers any realistic working set
// of concurrently-active orgs on a single process while bounding memory.
const CMM_MAX_ORGS = 512;

// Tiny insertion-ordered LRU over a Map (JS Maps iterate in insertion order, so
// the first key is the oldest). On access we delete+re-set to mark the entry
// most-recently-used; on insert past the cap we evict the oldest. No new dep.
const cmmByOrg = new Map<string, NodeCachingMaterialsManager>();

function getCmm(orgId: string): NodeCachingMaterialsManager {
  const existing = cmmByOrg.get(orgId);
  if (existing !== undefined) {
    // Mark most-recently-used: delete then re-set moves it to the newest slot.
    cmmByOrg.delete(orgId);
    cmmByOrg.set(orgId, existing);
    return existing;
  }
  const keyring = keyringProvider(orgId);
  const cache = getLocalCryptographicMaterialsCache(CMM_CACHE_CAPACITY);
  const cmm = new NodeCachingMaterialsManager({
    backingMaterials: keyring,
    cache,
    maxAge: CMM_MAX_AGE_MS,
    maxMessagesEncrypted: CMM_MAX_MESSAGES_ENCRYPTED,
    maxBytesEncrypted: CMM_MAX_BYTES_ENCRYPTED,
  });
  cmmByOrg.set(orgId, cmm);
  // Evict the oldest entries until we are back within the cap. Safe: pure cache.
  while (cmmByOrg.size > CMM_MAX_ORGS) {
    const oldest = cmmByOrg.keys().next().value;
    if (oldest === undefined) break;
    cmmByOrg.delete(oldest);
  }
  return cmm;
}

// --- Public API ----------------------------------------------------------------

/**
 * Encrypt a UTF-8 string for an org. Returns the self-describing ESDK message
 * bytes (wrapped data key + ciphertext + tag) — store this verbatim as bytea.
 * The encryptionContext `{ org_id }` is cryptographically bound into the message.
 *
 * @throws {EnvelopeCryptoError} on KMS / keyring failure (cause preserved).
 */
export async function encryptForOrg(orgId: string, plaintext: string): Promise<Buffer> {
  try {
    const { result } = await encrypt(getCmm(orgId), plaintext, {
      encryptionContext: { [ENC_CONTEXT_ORG_KEY]: orgId },
    });
    return result;
  } catch (err) {
    // Preserve an already-typed envelope error (e.g. the fail-closed prod guard
    // in the keyring provider) rather than re-wrapping it and losing its message.
    if (err instanceof EnvelopeCryptoError) throw err;
    throw new EnvelopeCryptoError(`encryptForOrg failed for org ${orgId}`, { cause: err });
  }
}

/**
 * Decrypt ESDK message bytes for an org back to the original UTF-8 string.
 * After the SDK returns we defensively assert the bound encryptionContext
 * `org_id` matches the requested org (the SDK already enforces it
 * cryptographically; this is belt-and-suspenders against a caller confusing
 * orgs, and surfaces cross-org ciphertext as a typed error).
 *
 * @throws {EnvelopeCryptoError} on KMS / keyring failure or enc-context mismatch.
 */
export async function decryptForOrg(
  orgId: string,
  ciphertext: Buffer | Uint8Array,
): Promise<string> {
  let plaintext: Buffer;
  let boundOrgId: string | undefined;
  try {
    const result = await decrypt(getCmm(orgId), ciphertext);
    plaintext = result.plaintext;
    boundOrgId = result.messageHeader.encryptionContext[ENC_CONTEXT_ORG_KEY];
  } catch (err) {
    if (err instanceof EnvelopeCryptoError) throw err;
    throw new EnvelopeCryptoError(`decryptForOrg failed for org ${orgId}`, { cause: err });
  }
  if (boundOrgId !== orgId) {
    throw new EnvelopeCryptoError(
      `encryptionContext org_id mismatch: expected ${orgId}, got ${String(boundOrgId)}`,
    );
  }
  return plaintext.toString('utf8');
}

// --- bytea (de)serialization for supabase-js / PostgREST -----------------------
//
// CRITICAL: supabase-js does NOT accept a Node Buffer for a bytea column. Passing
// a Buffer directly JSON-serializes it to `{"type":"Buffer","data":[...]}` and
// stores the UTF-8 bytes of THAT string — silently corrupting the ciphertext.
// PostgREST instead expects/returns the Postgres bytea hex text format `\x<hex>`.
//
// So on WRITE we hand PostgREST the hex-text form via `byteaToHex`, and on READ
// (PostgREST returns bytea as a `\x<hex>` string) we recover the Buffer via
// `hexToBuffer`. These two are the only correct bridge between the ESDK message
// bytes and a bytea column; every encrypt/decrypt call site uses them.

/**
 * Encode ESDK message bytes (Buffer) into the Postgres bytea hex-text literal
 * (`\x<hex>`) that supabase-js / PostgREST stores verbatim into a bytea column.
 * Pass the result as the column value on insert/update/upsert.
 */
export function byteaToHex(bytes: Buffer | Uint8Array): string {
  return '\\x' + Buffer.from(bytes).toString('hex');
}

/**
 * Decode a bytea value read back from supabase-js (PostgREST returns it as a
 * `\x<hex>` string) into a Buffer suitable for `decryptForOrg`. Tolerates an
 * optional leading `\x`. Throws `EnvelopeCryptoError` on a non-string / malformed
 * value so a corrupted column surfaces as a typed crypto error, not a silent
 * garbage decrypt.
 */
export function hexToBuffer(value: unknown): Buffer {
  if (typeof value !== 'string') {
    throw new EnvelopeCryptoError(`expected bytea hex string from PostgREST, got ${typeof value}`);
  }
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new EnvelopeCryptoError('malformed bytea hex string');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Convenience: encrypt a string for an org and return the bytea hex-text literal
 * ready to write to a `bytea` column via supabase-js. Equivalent to
 * `byteaToHex(await encryptForOrg(orgId, plaintext))`.
 */
export async function encryptForOrgToBytea(orgId: string, plaintext: string): Promise<string> {
  return byteaToHex(await encryptForOrg(orgId, plaintext));
}

/**
 * Convenience: decrypt a bytea value read from supabase-js (a `\x<hex>` string)
 * back to the original string. Equivalent to
 * `decryptForOrg(orgId, hexToBuffer(value))`.
 */
export async function decryptForOrgFromBytea(orgId: string, value: unknown): Promise<string> {
  return decryptForOrg(orgId, hexToBuffer(value));
}
