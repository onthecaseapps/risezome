/**
 * Migration + RLS regression tests for the Atlassian source kinds and the
 * `atlassian_connections` table (plan AT-U1).
 *
 * Runs against a local Supabase stack (`supabase start`, Docker). Auto-skips
 * when the stack isn't reachable; set `RISEZOME_RUN_RLS_TESTS=1` to require it.
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
  describe.skip('atlassian sources RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Skipped: `supabase start` not running. Set RISEZOME_RUN_RLS_TESTS=1 to require.
    });
  });
} else {
  describe('atlassian sources + atlassian_connections RLS', () => {
    let admin: SupabaseClient;
    let userA: TestUser;
    let orgA: string;
    let connectionId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      userA = await createTestUser(admin, 'rls-atlassian-a@example.com');
      orgA = await createOrgWithMember(admin, 'Atlassian Org A', userA.id, 'admin');

      const { data: conn, error } = await admin
        .from('atlassian_connections')
        .insert({
          org_id: orgA,
          access_token: 'at_secret',
          refresh_token: 'rt_secret',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          cloud_id: 'cloud_1',
          site_url: 'https://acme.atlassian.net',
        })
        .select('id')
        .single();
      if (error !== null || conn === null) {
        throw new Error(`failed to create atlassian_connection: ${error?.message ?? 'no row'}`);
      }
      connectionId = conn.id as string;
    });

    afterAll(async () => {
      await admin.auth.admin.deleteUser(userA.id).catch(() => undefined);
    });

    it('inserts jira and confluence sources off one Atlassian connection', async () => {
      const rows = [
        { org_id: orgA, kind: 'jira', connection_id: connectionId, external_id: 'PROJ-1', display_name: 'Platform', status: 'pending' },
        { org_id: orgA, kind: 'confluence', connection_id: connectionId, external_id: 'SPACE-1', display_name: 'Eng Docs', status: 'pending' },
      ];
      const { data, error } = await admin.from('sources').insert(rows).select('kind, installation_id');
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.kind).sort()).toEqual(['confluence', 'jira']);
      expect((data ?? []).every((r) => r.installation_id === null)).toBe(true);
    });

    it('rejects a jira source missing connection_id (per-kind identity check)', async () => {
      const { error } = await admin
        .from('sources')
        .insert({ org_id: orgA, kind: 'jira', external_id: 'PROJ-X', status: 'pending' });
      expect(error).not.toBeNull();
    });

    it('blocks a duplicate Atlassian resource (org, kind, external_id)', async () => {
      const { error } = await admin
        .from('sources')
        .insert({ org_id: orgA, kind: 'jira', connection_id: connectionId, external_id: 'PROJ-1', status: 'pending' });
      expect(error).not.toBeNull();
    });

    it('a member reads their org jira/confluence sources via RLS', async () => {
      const { data, error } = await userA.client
        .from('sources')
        .select('id, kind')
        .in('kind', ['jira', 'confluence']);
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('a member CANNOT read atlassian_connections (service-role only)', async () => {
      const { data, error } = await userA.client.from('atlassian_connections').select('id, access_token');
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
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
