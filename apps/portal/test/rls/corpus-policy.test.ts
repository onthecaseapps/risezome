// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom (see roles.test.ts /
// rls-test-harness notes). Auto-skips without a local Supabase stack unless
// RISEZOME_RUN_RLS_TESTS=1.
/**
 * org_corpus_policy RLS (plan U2): members read their own org's policy;
 * outsiders read none; there is no client write policy (service-role only).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

async function isStackReachable(): Promise<boolean> {
  if (SUPABASE_ANON_KEY === '' || SUPABASE_SERVICE_ROLE_KEY === '') return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_ANON_KEY } });
    return res.ok;
  } catch {
    return false;
  }
}

const stackReachable = await isStackReachable();

if (!stackReachable && !FORCE) {
  describe.skip('org_corpus_policy RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('org_corpus_policy RLS', () => {
    let admin: SupabaseClient;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      member = await createTestUser(admin, 'rls-policy-mem@example.com');
      outsider = await createTestUser(admin, 'rls-policy-out@example.com');
      orgId = await createOrgWithMember(admin, 'Policy Org', member.id, 'manager');
      // outsider belongs to a different org (never a member of orgId)
      await createOrgWithMember(admin, 'Other Org', outsider.id, 'manager');
      // Seed the org's policy row via service-role (the only write path).
      const { error } = await admin
        .from('org_corpus_policy')
        .insert({ org_id: orgId, preset: 'recommended' });
      if (error !== null) throw new Error(`seed policy failed: ${error.message}`);
    });

    afterAll(async () => {
      await admin.from('org_corpus_policy').delete().eq('org_id', orgId);
    });

    it('a member reads their org policy', async () => {
      const { data, error } = await member.client
        .from('org_corpus_policy')
        .select('org_id, preset')
        .eq('org_id', orgId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0]?.preset).toBe('recommended');
    });

    it('an outsider reads no rows of another org policy', async () => {
      const { data, error } = await outsider.client
        .from('org_corpus_policy')
        .select('org_id')
        .eq('org_id', orgId);
      expect(error).toBeNull(); // RLS filters rather than errors
      expect(data).toHaveLength(0);
    });

    it('a member cannot write the policy (no client write policy)', async () => {
      const ins = await member.client
        .from('org_corpus_policy')
        .insert({ org_id: orgId, preset: 'index_everything' });
      expect(ins.error).not.toBeNull(); // RLS denies the INSERT

      const upd = await member.client
        .from('org_corpus_policy')
        .update({ preset: 'index_everything' })
        .eq('org_id', orgId);
      // No UPDATE policy → zero rows affected (PostgREST returns no error but
      // the write is a no-op); assert the value did not change.
      void upd;
      const { data } = await admin
        .from('org_corpus_policy')
        .select('preset')
        .eq('org_id', orgId)
        .single();
      expect(data?.preset).toBe('recommended');
    });
  });
}

async function createTestUser(admin: SupabaseClient, email: string): Promise<TestUser> {
  const password = `RlsTest_${Math.random().toString(36).slice(2)}!`;
  const { data: existing } = await admin.auth.admin.listUsers();
  const prior = existing?.users.find((u) => u.email === email);
  if (prior !== undefined) {
    await admin.auth.admin.deleteUser(prior.id).catch(() => undefined);
  }
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error !== null || created.user === null) {
    throw new Error(`Failed to create test user ${email}: ${error?.message ?? 'no user'}`);
  }
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr !== null) {
    throw new Error(`Failed to sign in test user ${email}: ${signInErr.message}`);
  }
  return { id: created.user.id, email, client };
}

async function createOrgWithMember(
  admin: SupabaseClient,
  orgName: string,
  userId: string,
  role: 'manager' | 'member',
): Promise<string> {
  const { data: org, error } = await admin.from('orgs').insert({ name: orgName }).select('id').single();
  if (error !== null || org === null) {
    throw new Error(`Failed to create org ${orgName}: ${error?.message ?? 'no row'}`);
  }
  const { error: memErr } = await admin
    .from('org_members')
    .insert({ org_id: org.id as string, user_id: userId, role, can_invite_bot: role === 'manager' });
  if (memErr !== null) throw new Error(`Failed to add member: ${memErr.message}`);
  return org.id as string;
}
