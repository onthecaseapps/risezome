/**
 * RLS regression tests for the orgs + org_members tables (U1).
 *
 * Runs against a local Supabase stack started via `supabase start` (Docker
 * required). Skipped automatically when the stack isn't reachable so this
 * doesn't break CI on environments without Docker — set
 * `UPWELL_RUN_RLS_TESTS=1` to force the suite to error instead of skip when
 * the stack is missing.
 *
 * Pattern: create two distinct auth.users via the admin API, create two
 * distinct orgs, assert each user only sees their own org via the
 * RLS-bound publishable-key client. Service-role client used only for
 * setup/teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['UPWELL_RUN_RLS_TESTS'] === '1';

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

async function isStackReachable(): Promise<boolean> {
  if (SUPABASE_ANON_KEY === '' || SUPABASE_SERVICE_ROLE_KEY === '') return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_ANON_KEY },
    });
    return res.ok;
  } catch {
    return false;
  }
}

const stackReachable = await isStackReachable();

if (!stackReachable && !FORCE) {
  describe.skip('orgs RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Skipped because supabase start is not running. Set UPWELL_RUN_RLS_TESTS=1
      // to require these tests in CI environments where Docker is available.
    });
  });
} else {
  describe('orgs + org_members RLS', () => {
    let admin: SupabaseClient;
    let userA: TestUser;
    let userB: TestUser;
    let orgA: string;
    let orgB: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      userA = await createTestUser(admin, 'rls-test-a@example.com');
      userB = await createTestUser(admin, 'rls-test-b@example.com');

      orgA = await createOrgWithMember(admin, 'Org A', userA.id, 'admin');
      orgB = await createOrgWithMember(admin, 'Org B', userB.id, 'admin');
    });

    afterAll(async () => {
      // Cascade-delete via auth.users removal; admin.deleteUser cascades to
      // org_members and orgs via the FK ON DELETE CASCADE chain.
      await admin.auth.admin.deleteUser(userA.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(userB.id).catch(() => undefined);
    });

    it('user A sees their own org and not user B\'s', async () => {
      const { data, error } = await userA.client.from('orgs').select('id, name');
      expect(error).toBeNull();
      const ids = (data ?? []).map((row) => row.id as string);
      expect(ids).toContain(orgA);
      expect(ids).not.toContain(orgB);
    });

    it('user B sees their own org and not user A\'s', async () => {
      const { data, error } = await userB.client.from('orgs').select('id, name');
      expect(error).toBeNull();
      const ids = (data ?? []).map((row) => row.id as string);
      expect(ids).toContain(orgB);
      expect(ids).not.toContain(orgA);
    });

    it('user A reading org_members sees only their own org\'s memberships', async () => {
      const { data, error } = await userA.client.from('org_members').select('org_id, user_id');
      expect(error).toBeNull();
      const rows = data ?? [];
      // Every returned row's org_id must be orgA (the only org user A belongs to).
      for (const row of rows) {
        expect(row.org_id).toBe(orgA);
      }
      // And at minimum user A's own row is present.
      expect(rows.some((r) => r.user_id === userA.id)).toBe(true);
    });

    it('anonymous (no JWT) client sees zero rows in orgs', async () => {
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data, error } = await anon.from('orgs').select('id');
      // RLS for authenticated-only policies returns empty + no error for anon.
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    });
  });
}

async function createTestUser(admin: SupabaseClient, email: string): Promise<TestUser> {
  const password = `RlsTest_${Math.random().toString(36).slice(2)}!`;
  // Delete any leftover user from a prior failed run before creating.
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
  role: 'admin' | 'member',
): Promise<string> {
  const { data: org, error: orgErr } = await admin
    .from('orgs')
    .insert({ name: orgName })
    .select('id')
    .single();
  if (orgErr !== null || org === null) {
    throw new Error(`Failed to create org ${orgName}: ${orgErr?.message ?? 'no row'}`);
  }
  const { error: memberErr } = await admin
    .from('org_members')
    .insert({ org_id: org.id, user_id: userId, role });
  if (memberErr !== null) {
    throw new Error(`Failed to create org_member: ${memberErr.message}`);
  }
  return org.id as string;
}
