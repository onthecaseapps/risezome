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
const { encrypt, decrypt } = buildClient(
  CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT,
);

const ENC_CONTEXT_ORG_KEY = 'org_id';

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
  const keyBytes = hkdfSync('sha256', Buffer.from(devSecret), Buffer.alloc(0), Buffer.from(`org:${orgId}`), 32);
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
export function __setKeyringProviderForTests(
  fn: KeyringProvider | null,
): void {
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

const cmmByOrg = new Map<string, NodeCachingMaterialsManager>();

function getCmm(orgId: string): NodeCachingMaterialsManager {
  let cmm = cmmByOrg.get(orgId);
  if (cmm === undefined) {
    const keyring = keyringProvider(orgId);
    const cache = getLocalCryptographicMaterialsCache(CMM_CACHE_CAPACITY);
    cmm = new NodeCachingMaterialsManager({
      backingMaterials: keyring,
      cache,
      maxAge: CMM_MAX_AGE_MS,
      maxMessagesEncrypted: CMM_MAX_MESSAGES_ENCRYPTED,
      maxBytesEncrypted: CMM_MAX_BYTES_ENCRYPTED,
    });
    cmmByOrg.set(orgId, cmm);
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
export async function encryptForOrg(
  orgId: string,
  plaintext: string,
): Promise<Buffer> {
  try {
    const { result } = await encrypt(getCmm(orgId), plaintext, {
      encryptionContext: { [ENC_CONTEXT_ORG_KEY]: orgId },
    });
    return result;
  } catch (err) {
    throw new EnvelopeCryptoError(
      `encryptForOrg failed for org ${orgId}`,
      { cause: err },
    );
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
    throw new EnvelopeCryptoError(
      `decryptForOrg failed for org ${orgId}`,
      { cause: err },
    );
  }
  if (boundOrgId !== orgId) {
    throw new EnvelopeCryptoError(
      `encryptionContext org_id mismatch: expected ${orgId}, got ${String(boundOrgId)}`,
    );
  }
  return plaintext.toString('utf8');
}
