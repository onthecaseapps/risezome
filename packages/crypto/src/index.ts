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
//
// The test-only keyring-injection hook (__setKeyringProviderForTests) is
// deliberately NOT re-exported here: it is not production API. Tests import it
// directly from '../src/envelope.js'.
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
} from './envelope.js';
