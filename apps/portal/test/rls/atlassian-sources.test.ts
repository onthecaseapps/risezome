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
// Encryption key used by the pgcrypto helpers for this test's token round-trips.
const TOKEN_KEY = 'rls-atlassian-test-key-' + 'k'.repeat(40);

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
      orgA = await createOrgWithMember(admin, 'Atlassian Org A', userA.id, 'manager');

      // Tokens are stored encrypted (U2): encrypt via the pgcrypto helper before insert.
      const [atEnc, rtEnc] = await Promise.all([
        admin.rpc('encrypt_refresh_token', { plaintext: 'at_secret', key: TOKEN_KEY }),
        admin.rpc('encrypt_refresh_token', { plaintext: 'rt_secret', key: TOKEN_KEY }),
      ]);
      const { data: conn, error } = await admin
        .from('atlassian_connections')
        .insert({
          org_id: orgA,
          access_token_enc: atEnc.data as unknown as string,
          refresh_token_enc: rtEnc.data as unknown as string,
          token_version: 0,
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
        {
          org_id: orgA,
          kind: 'jira',
          connection_id: connectionId,
          external_id: 'PROJ-1',
          display_name: 'Platform',
          status: 'pending',
        },
        {
          org_id: orgA,
          kind: 'confluence',
          connection_id: connectionId,
          external_id: 'SPACE-1',
          display_name: 'Eng Docs',
          status: 'pending',
        },
      ];
      const { data, error } = await admin
        .from('sources')
        .insert(rows)
        .select('kind, installation_id');
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
        .insert({
          org_id: orgA,
          kind: 'jira',
          connection_id: connectionId,
          external_id: 'PROJ-1',
          status: 'pending',
        });
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
      const { data, error } = await userA.client.from('atlassian_connections').select('id');
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    });

    it('stores tokens encrypted at rest — no plaintext column, decrypt round-trips (U2)', async () => {
      // The plaintext columns are gone: selecting them is a schema error.
      const plaintextSel = await admin.from('atlassian_connections').select('refresh_token');
      expect(plaintextSel.error).not.toBeNull();

      // The stored ciphertext decrypts back to the original via the pgcrypto helper.
      const { data: row } = await admin
        .from('atlassian_connections')
        .select('refresh_token_enc, token_version')
        .eq('id', connectionId)
        .single();
      expect(row?.token_version).toBe(0);
      const dec = await admin.rpc('decrypt_refresh_token', {
        ciphertext: (row as { refresh_token_enc: string }).refresh_token_enc,
        key: TOKEN_KEY,
      });
      expect(dec.data).toBe('rt_secret');
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
