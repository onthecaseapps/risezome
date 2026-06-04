import { hkdfSync } from 'node:crypto';
import {
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
  type KeyringNode,
} from '@aws-crypto/client-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __setKeyringProviderForTests,
  aliasForOrg,
  byteaToHex,
  CRYPTO_VERSION,
  decryptForOrg,
  decryptForOrgFromBytea,
  encryptForOrg,
  encryptForOrgToBytea,
  EnvelopeCryptoError,
  hexToBuffer,
} from '../src/envelope.js';

// Deterministic per-org 32-byte raw wrapping key. Different orgId -> different
// key material (HKDF over a fixed IKM with orgId as info), so cross-org decrypt
// genuinely fails on key mismatch rather than only on enc-context.
function rawKeyForOrg(orgId: string): Uint8Array {
  const ikm = Buffer.from('risezome-crypto-test-ikm', 'utf8');
  const salt = Buffer.from('risezome-crypto-test-salt', 'utf8');
  return new Uint8Array(hkdfSync('sha256', ikm, salt, Buffer.from(orgId, 'utf8'), 32));
}

// A RawAesKeyringNode swaps ONLY the wrapping-key source for the production
// KmsKeyringNode; the ESDK message format, encryptionContext binding, and the
// caching CMM are all exercised for real with no AWS network.
function rawKeyringFor(orgId: string): RawAesKeyringNode {
  return new RawAesKeyringNode({
    keyName: aliasForOrg(orgId),
    keyNamespace: 'risezome-test',
    unencryptedMasterKey: rawKeyForOrg(orgId),
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
}

afterEach(() => {
  __setKeyringProviderForTests(null);
  vi.restoreAllMocks();
});

describe('local dev-fallback keyring (RISEZOME_DEV_CRYPTO_KEY)', () => {
  it('round-trips via the real default provider (no injection) and isolates orgs', async () => {
    const prev = process.env.RISEZOME_DEV_CRYPTO_KEY;
    process.env.RISEZOME_DEV_CRYPTO_KEY = 'dev-fallback-secret-for-tests';
    __setKeyringProviderForTests(null); // exercise the production default provider; clears the CMM memo
    try {
      const ct = await encryptForOrg('orgDEV', 'local secret');
      expect(await decryptForOrg('orgDEV', ct)).toBe('local secret');
      // A different org derives a different wrapping key, so decrypt fails.
      await expect(decryptForOrg('orgOTHER', ct)).rejects.toBeInstanceOf(EnvelopeCryptoError);
    } finally {
      if (prev === undefined) delete process.env.RISEZOME_DEV_CRYPTO_KEY;
      else process.env.RISEZOME_DEV_CRYPTO_KEY = prev;
      __setKeyringProviderForTests(null);
    }
  });

  it('FAILS CLOSED: refuses the dev fallback when NODE_ENV=production', async () => {
    const prevKey = process.env.RISEZOME_DEV_CRYPTO_KEY;
    const prevEnv = process.env.NODE_ENV;
    process.env.RISEZOME_DEV_CRYPTO_KEY = 'dev-fallback-secret-for-tests';
    process.env.NODE_ENV = 'production';
    __setKeyringProviderForTests(null); // exercise the production default provider
    try {
      await expect(encryptForOrg('orgPROD', 'should not encrypt')).rejects.toBeInstanceOf(
        EnvelopeCryptoError,
      );
      await expect(encryptForOrg('orgPROD', 'should not encrypt')).rejects.toThrow(
        /refusing dev crypto fallback in production/,
      );
    } finally {
      if (prevKey === undefined) delete process.env.RISEZOME_DEV_CRYPTO_KEY;
      else process.env.RISEZOME_DEV_CRYPTO_KEY = prevKey;
      if (prevEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevEnv;
      __setKeyringProviderForTests(null);
    }
  });
});

describe('envelope crypto', () => {
  it('round-trips a string for an org (a)', async () => {
    __setKeyringProviderForTests(rawKeyringFor);
    const orgId = 'org-alpha';
    const secret = 'refresh-token-🔐-value';
    const ct = await encryptForOrg(orgId, secret);
    expect(Buffer.isBuffer(ct)).toBe(true);
    const pt = await decryptForOrg(orgId, ct);
    expect(pt).toBe(secret);
  });

  it('isolates orgs: org A ciphertext fails under org B (b)', async () => {
    __setKeyringProviderForTests(rawKeyringFor);
    const ct = await encryptForOrg('org-alpha', 'alpha-secret');
    // org-beta has a different raw wrapping key -> unwrap fails -> throws.
    await expect(decryptForOrg('org-beta', ct)).rejects.toBeInstanceOf(EnvelopeCryptoError);
  });

  it('produces opaque, non-deterministic ciphertext (c)', async () => {
    __setKeyringProviderForTests(rawKeyringFor);
    const orgId = 'org-alpha';
    const secret = 'PLAINTEXT_NEEDLE';
    const a = await encryptForOrg(orgId, secret);
    const b = await encryptForOrg(orgId, secret);
    // No plaintext substring leaks into the message bytes.
    expect(a.toString('latin1')).not.toContain(secret);
    expect(a.toString('utf8')).not.toContain(secret);
    // Two encrypts of the same input are not byte-identical (fresh IV/message).
    expect(Buffer.compare(a, b)).not.toBe(0);
    // Both still decrypt correctly.
    expect(await decryptForOrg(orgId, a)).toBe(secret);
    expect(await decryptForOrg(orgId, b)).toBe(secret);
  });

  it('asserts/throws on an org (enc-context) mismatch (d)', async () => {
    // Give two distinct orgs the SAME wrapping key so unwrap succeeds, isolating
    // the defensive enc-context assertion as the thing that must reject.
    const sharedKey = rawKeyForOrg('shared');
    const sharedKeyring = (_orgId: string): KeyringNode =>
      new RawAesKeyringNode({
        keyName: 'shared-test-key',
        keyNamespace: 'risezome-test',
        unencryptedMasterKey: sharedKey,
        wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
      });
    __setKeyringProviderForTests(sharedKeyring);

    const ct = await encryptForOrg('org-alpha', 'secret');
    // Unwrap would succeed (same key), but enc-context org_id is 'org-alpha'
    // while we ask as 'org-beta' -> the SDK enforces, surfaced as a typed error.
    await expect(decryptForOrg('org-beta', ct)).rejects.toBeInstanceOf(EnvelopeCryptoError);
  });

  it('reuses cached materials across many encrypts for one org (e)', async () => {
    const orgId = 'org-cache';
    const keyring = rawKeyringFor(orgId);
    // Spy on the keyring's data-key generation. With the caching CMM, a burst of
    // encrypts within bounds should generate the data key only ONCE.
    const genSpy = vi.spyOn(
      keyring as unknown as { _onEncrypt: (...a: unknown[]) => unknown },
      '_onEncrypt',
    );
    __setKeyringProviderForTests(() => keyring);

    const N = 50;
    const cts: Buffer[] = [];
    for (let i = 0; i < N; i++) {
      cts.push(await encryptForOrg(orgId, `message-${i}`));
    }
    // Cached: far fewer keyring generations than messages (one for the burst).
    expect(genSpy.mock.calls.length).toBeLessThan(N);
    expect(genSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Correctness still holds under repeated cached calls.
    for (let i = 0; i < N; i++) {
      expect(await decryptForOrg(orgId, cts[i]!)).toBe(`message-${i}`);
    }
  });

  it('round-trips an empty string (f)', async () => {
    __setKeyringProviderForTests(rawKeyringFor);
    const orgId = 'org-empty';
    const ct = await encryptForOrg(orgId, '');
    expect(Buffer.isBuffer(ct)).toBe(true);
    expect(await decryptForOrg(orgId, ct)).toBe('');
    // and through the bytea bridge
    const hex = await encryptForOrgToBytea(orgId, '');
    expect(await decryptForOrgFromBytea(orgId, hex)).toBe('');
  });

  it('builds the deterministic per-org alias from KMS_ALIAS_PREFIX', () => {
    const prev = process.env.KMS_ALIAS_PREFIX;
    delete process.env.KMS_ALIAS_PREFIX;
    expect(aliasForOrg('abc')).toBe('alias/risezome-org-abc');
    process.env.KMS_ALIAS_PREFIX = 'acme';
    expect(aliasForOrg('abc')).toBe('alias/acme-org-abc');
    if (prev === undefined) delete process.env.KMS_ALIAS_PREFIX;
    else process.env.KMS_ALIAS_PREFIX = prev;
  });
});

describe('bytea (de)serialization helpers', () => {
  it('byteaToHex/hexToBuffer round-trip arbitrary bytes incl. NUL', () => {
    const buf = Buffer.from([0x00, 0x01, 0xff, 0x10, 0x41]);
    const hex = byteaToHex(buf);
    expect(hex).toBe('\\x0001ff1041');
    expect(hexToBuffer(hex).equals(buf)).toBe(true);
    // tolerate a value without the leading \x (defensive)
    expect(hexToBuffer('0001ff1041').equals(buf)).toBe(true);
  });

  it('hexToBuffer rejects non-strings and malformed hex with a typed error', () => {
    expect(() => hexToBuffer(123)).toThrow(EnvelopeCryptoError);
    expect(() => hexToBuffer(null)).toThrow(EnvelopeCryptoError);
    expect(() => hexToBuffer('\\xzz')).toThrow(EnvelopeCryptoError);
    expect(() => hexToBuffer('\\x012')).toThrow(EnvelopeCryptoError); // odd length
  });

  it('encryptForOrgToBytea -> decryptForOrgFromBytea round-trips through a bytea literal', async () => {
    __setKeyringProviderForTests(rawKeyringFor);
    const orgId = 'org-bytea';
    const secret = 'a-secret-with-emoji-🔐';
    const hex = await encryptForOrgToBytea(orgId, secret);
    expect(typeof hex).toBe('string');
    expect(hex.startsWith('\\x')).toBe(true);
    expect(await decryptForOrgFromBytea(orgId, hex)).toBe(secret);
  });

  it('exposes the crypto-version sentinel (1=legacy pgcrypto, 2=KMS-ESDK)', () => {
    expect(CRYPTO_VERSION.LEGACY_PGCRYPTO).toBe(1);
    expect(CRYPTO_VERSION.KMS_ESDK).toBe(2);
  });
});
