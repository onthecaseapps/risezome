// @risezome/crypto — shared per-org envelope encryption.
//
// Public API (see ./envelope.ts for full docs):
//   encryptForOrg(orgId, plaintext): Promise<Buffer>   — raw ESDK message bytes
//   decryptForOrg(orgId, ciphertext): Promise<string>
//   encryptForOrgToBytea(orgId, plaintext): Promise<string> — bytea hex-text to store
//   decryptForOrgFromBytea(orgId, value): Promise<string>   — decode+decrypt a read
//   byteaToHex(bytes): string / hexToBuffer(value): Buffer  — bytea bridge helpers
//   aliasForOrg(orgId): string                         — deterministic KMS alias
//   EnvelopeCryptoError                                — typed failure
//   __setKeyringProviderForTests(fn | null)            — test-only injection
export {
  encryptForOrg,
  decryptForOrg,
  encryptForOrgToBytea,
  decryptForOrgFromBytea,
  byteaToHex,
  hexToBuffer,
  aliasForOrg,
  CRYPTO_VERSION,
  EnvelopeCryptoError,
  __setKeyringProviderForTests,
} from './envelope.js';
