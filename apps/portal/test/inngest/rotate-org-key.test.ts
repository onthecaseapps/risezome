// @vitest-environment node
// Crypto round-trips here use @risezome/crypto's AWS Encryption SDK, which must
// load as a single real Node module instance (jsdom/Vite-SSR duplicates it).
/**
 * U12 per-org rotation isolation test. Seeds two orgs each with a KMS-encrypted
 * recap, rotates ONE org, then asserts:
 *   - the rotated org's ciphertext bytes changed (fresh data key) but still
 *     decrypt to the same plaintext;
 *   - the OTHER org's ciphertext bytes are byte-for-byte unchanged and still
 *     decrypt — rotation is scoped strictly to one org.
 *
 * Uses the local RawAES dev fallback (RISEZOME_DEV_CRYPTO_KEY) — no AWS needed.
 * Auto-skips without a local Supabase stack unless RISEZOME_RUN_RLS_TESTS=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CRYPTO_VERSION, decryptForOrgFromBytea, encryptForOrgToBytea } from '@risezome/crypto';

process.env['RISEZOME_DEV_CRYPTO_KEY'] =
  process.env['RISEZOME_DEV_CRYPTO_KEY'] ?? 'dev-test-key-1234567890abcdef';

const { rotateOrgKey, disableOrgKey } = await import(
  '../../src/inngest/functions/rotate-org-key'
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

interface SeededOrg {
  orgId: string;
  userId: string;
  meetingId: string;
  plaintext: string;
}

async function seedKmsRecap(
  admin: SupabaseClient,
  name: string,
  plaintext: string,
): Promise<SeededOrg> {
  const { data: u } = await admin.auth.admin.createUser({
    email: `rls-u12-${name}-${Date.now()}@example.com`,
    password: `U12_${Math.random().toString(36).slice(2)}!`,
    email_confirm: true,
  });
  const userId = u!.user!.id;
  const { data: org } = await admin
    .from('orgs')
    .insert({ name: `U12 ${name}` })
    .select('id')
    .single();
  const orgId = (org as { id: string }).id;
  await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role: 'manager', can_invite_bot: true });
  // Provisioning record (dev fallback = pure DB row); disableOrgKey updates it.
  await admin
    .from('org_encryption_keys')
    .insert({ org_id: orgId, kms_alias: `alias/test-org-${orgId}`, status: 'active' });
  const recapEnc = await encryptForOrgToBytea(orgId, plaintext);
  const { data: m } = await admin
    .from('meetings')
    .insert({
      org_id: orgId,
      user_id: userId,
      conference_url: `https://zoom.us/j/u12-${name}-${Math.random().toString(36).slice(2)}`,
      status: 'completed',
      recap_status: 'done',
      recap_text_enc: recapEnc,
      recap_key_version: CRYPTO_VERSION.KMS_ESDK,
    })
    .select('meeting_id')
    .single();
  return { orgId, userId, meetingId: (m as { meeting_id: string }).meeting_id, plaintext };
}

async function readRecapEnc(admin: SupabaseClient, meetingId: string): Promise<string> {
  const { data } = await admin
    .from('meetings')
    .select('recap_text_enc')
    .eq('meeting_id', meetingId)
    .single();
  return (data as { recap_text_enc: string }).recap_text_enc;
}

async function cleanup(admin: SupabaseClient, o: SeededOrg): Promise<void> {
  await admin.from('meetings').delete().eq('meeting_id', o.meetingId).then(undefined, () => undefined);
  await admin.from('org_members').delete().eq('org_id', o.orgId).then(undefined, () => undefined);
  await admin.from('org_encryption_keys').delete().eq('org_id', o.orgId).then(undefined, () => undefined);
  await admin.from('orgs').delete().eq('id', o.orgId).then(undefined, () => undefined);
  await admin.auth.admin.deleteUser(o.userId).catch(() => undefined);
}

if (!stackReachable && !FORCE) {
  describe.skip('U12 rotate-org-key (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('U12 per-org key rotation is isolated to one org', () => {
    let admin: SupabaseClient;
    let orgA: SeededOrg;
    let orgB: SeededOrg;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      orgA = await seedKmsRecap(admin, 'A', 'Org A recap: roadmap locked for H2.');
      orgB = await seedKmsRecap(admin, 'B', 'Org B recap: hiring freeze lifted.');
    });

    afterAll(async () => {
      await cleanup(admin, orgA);
      await cleanup(admin, orgB);
    });

    it('rotating org A re-encrypts only org A; org B ciphertext is untouched; both still decrypt', async () => {
      const aBefore = await readRecapEnc(admin, orgA.meetingId);
      const bBefore = await readRecapEnc(admin, orgB.meetingId);

      const result = await rotateOrgKey(admin, orgA.orgId);
      const recap = result.columns.find((c) => c.column === 'meetings.recap_text_enc');
      expect(recap!.rotated).toBeGreaterThanOrEqual(1);

      const aAfter = await readRecapEnc(admin, orgA.meetingId);
      const bAfter = await readRecapEnc(admin, orgB.meetingId);

      // Org A's ciphertext bytes changed (fresh data key)…
      expect(aAfter).not.toBe(aBefore);
      // …but still decrypts to the same plaintext.
      expect(await decryptForOrgFromBytea(orgA.orgId, aAfter)).toBe(orgA.plaintext);

      // Org B is byte-for-byte unchanged and still decrypts.
      expect(bAfter).toBe(bBefore);
      expect(await decryptForOrgFromBytea(orgB.orgId, bAfter)).toBe(orgB.plaintext);
    });

    it('disableOrgKey marks the org key revoked (operational record)', async () => {
      await disableOrgKey(admin, orgA.orgId);
      const { data } = await admin
        .from('org_encryption_keys')
        .select('status')
        .eq('org_id', orgA.orgId)
        .single();
      expect((data as { status: string }).status).toBe('revoked');
    });
  });
}
