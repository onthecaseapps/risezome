// @risezome/crypto — shared per-org envelope encryption.
//
// Public API (see ./envelope.ts for full docs):
//   encryptForOrg(orgId, plaintext): Promise<Buffer>   — store result as bytea
//   decryptForOrg(orgId, ciphertext): Promise<string>
//   aliasForOrg(orgId): string                         — deterministic KMS alias
//   EnvelopeCryptoError                                — typed failure
//   __setKeyringProviderForTests(fn | null)            — test-only injection
export {
  encryptForOrg,
  decryptForOrg,
  aliasForOrg,
  EnvelopeCryptoError,
  __setKeyringProviderForTests,
} from './envelope.js';
