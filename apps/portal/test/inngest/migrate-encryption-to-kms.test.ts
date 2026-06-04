// @vitest-environment node
// Crypto round-trips here use @risezome/crypto's AWS Encryption SDK, which must
// load as a single real Node module instance (jsdom/Vite-SSR duplicates it).
/**
 * Characterization test for the U11 one-time re-encryption backfill
 * (migrate-encryption-to-kms). Seeds a row encrypted under the OLD global
 * pgcrypto path (public.encrypt_refresh_token + a global key, version=1), runs
 * the backfill for that org, and asserts:
 *   - the row is now KMS_ESDK and decryptForOrgFromBytea recovers the ORIGINAL
 *     plaintext byte-for-byte;
 *   - re-running the backfill is a no-op (idempotent — migrated count 0).
 *
 * The NEW per-org path uses the local RawAES dev fallback (RISEZOME_DEV_CRYPTO_KEY)
 * so no AWS is needed; the OLD path uses the pgcrypto helpers still present in the
 * local DB (the U13 drop migration is intentionally NOT applied locally).
 *
 * Auto-skips without a local Supabase stack unless RISEZOME_RUN_RLS_TESTS=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CRYPTO_VERSION, decryptForOrgFromBytea } from '@risezome/crypto';

// New-path per-org wrapping key (dev fallback). Set before importing the module.
process.env['RISEZOME_DEV_CRYPTO_KEY'] =
  process.env['RISEZOME_DEV_CRYPTO_KEY'] ?? 'dev-test-key-1234567890abcdef';
// Old-path global pgcrypto key, used to seed the legacy ciphertext.
const LEGACY_KEY = 'u11-legacy-global-key-for-seeding';
process.env['USER_TOKEN_ENCRYPTION_KEY'] =
  process.env['USER_TOKEN_ENCRYPTION_KEY'] ?? LEGACY_KEY;

const { migrateOrgEncryption } = await import(
  '../../src/inngest/functions/migrate-encryption-to-kms'
);

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';

async function isStackReachable(): Promise<boolean> {
  if (SUPABASE_SERVICE_ROLE_KEY === '') return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY },
    });
    return res.ok;
  } catch {
    return false;
  }
}

const stackReachable = await isStackReachable();

async function seedLegacyRecap(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  plaintext: string,
): Promise<string> {
  // Encrypt under the OLD pgcrypto path (the helper still present pre-U13).
  const { data: enc, error: encErr } = await admin.rpc('encrypt_refresh_token', {
    plaintext,
    key: process.env['USER_TOKEN_ENCRYPTION_KEY'],
  });
  expect(encErr).toBeNull();
  expect(enc).not.toBeNull();
  const { data, error } = await admin
    .from('meetings')
    .insert({
      org_id: orgId,
      user_id: userId,
      conference_url: `https://zoom.us/j/u11-${Math.random().toString(36).slice(2)}`,
      status: 'completed',
      recap_status: 'done',
      // PostgREST returns the bytea as a `\x...` string; write it straight back.
      recap_text_enc: enc as unknown as string,
      recap_key_version: CRYPTO_VERSION.LEGACY_PGCRYPTO,
    })
    .select('meeting_id')
    .single();
  expect(error).toBeNull();
  return (data as { meeting_id: string }).meeting_id;
}

if (!stackReachable && !FORCE) {
  describe.skip('U11 migrate-encryption-to-kms (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('U11 one-time re-encryption: pgcrypto → per-org KMS', () => {
    let admin: SupabaseClient;
    let orgId: string;
    let userId: string;
    let meetingId: string;
    const plaintext = 'Legacy recap: board approved the Q3 raise of $12.5M.';

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: u } = await admin.auth.admin.createUser({
        email: `rls-u11-${Date.now()}@example.com`,
        password: `U11_${Math.random().toString(36).slice(2)}!`,
        email_confirm: true,
      });
      userId = u!.user!.id;
      const { data: org, error: orgErr } = await admin
        .from('orgs')
        .insert({ name: 'U11 Migration Org' })
        .select('id')
        .single();
      expect(orgErr).toBeNull();
      orgId = (org as { id: string }).id;
      await admin
        .from('org_members')
        .insert({ org_id: orgId, user_id: userId, role: 'manager', can_invite_bot: true });
      meetingId = await seedLegacyRecap(admin, orgId, userId, plaintext);
    });

    afterAll(async () => {
      await admin.from('meetings').delete().eq('meeting_id', meetingId).then(undefined, () => undefined);
      await admin.from('org_members').delete().eq('org_id', orgId).then(undefined, () => undefined);
      await admin.from('org_encryption_keys').delete().eq('org_id', orgId).then(undefined, () => undefined);
      await admin.from('orgs').delete().eq('id', orgId).then(undefined, () => undefined);
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    });

    it('re-encrypts a legacy pgcrypto row to KMS_ESDK and recovers the original plaintext', async () => {
      // Sanity: the seeded row is legacy.
      const before = await admin
        .from('meetings')
        .select('recap_key_version')
        .eq('meeting_id', meetingId)
        .single();
      expect((before.data as { recap_key_version: number }).recap_key_version).toBe(
        CRYPTO_VERSION.LEGACY_PGCRYPTO,
      );

      const result = await migrateOrgEncryption(admin, orgId);
      const recap = result.columns.find((c) => c.column === 'meetings.recap_text_enc');
      expect(recap).toBeDefined();
      expect(recap!.migrated).toBeGreaterThanOrEqual(1);

      // The row is now KMS_ESDK and decrypts to the ORIGINAL plaintext.
      const after = await admin
        .from('meetings')
        .select('recap_text_enc, recap_key_version')
        .eq('meeting_id', meetingId)
        .single();
      const row = after.data as { recap_text_enc: string; recap_key_version: number };
      expect(row.recap_key_version).toBe(CRYPTO_VERSION.KMS_ESDK);
      const decrypted = await decryptForOrgFromBytea(orgId, row.recap_text_enc);
      expect(decrypted).toBe(plaintext);
    });

    it('is idempotent — re-running migrates nothing', async () => {
      const result = await migrateOrgEncryption(admin, orgId);
      const recap = result.columns.find((c) => c.column === 'meetings.recap_text_enc');
      expect(recap!.migrated).toBe(0);

      // Still decrypts to the same plaintext after the no-op pass.
      const after = await admin
        .from('meetings')
        .select('recap_text_enc')
        .eq('meeting_id', meetingId)
        .single();
      const decrypted = await decryptForOrgFromBytea(
        orgId,
        (after.data as { recap_text_enc: string }).recap_text_enc,
      );
      expect(decrypted).toBe(plaintext);
    });
  });
}
