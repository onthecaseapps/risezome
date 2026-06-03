/**
 * Migration + RLS regression tests for the generalized `sources` model and the
 * `trello_connections` table (plan U1).
 *
 * Runs against a local Supabase stack (`supabase start`, Docker). Auto-skips
 * when the stack isn't reachable; set `RISEZOME_RUN_RLS_TESTS=1` to require it.
 *
 * Covers:
 *   - a Trello source (kind='trello', installation_id NULL, connection_id set)
 *     inserts successfully;
 *   - the per-kind identity check rejects a GitHub source with no installation
 *     and a Trello source with no connection;
 *   - an org member reads their org's sources regardless of kind;
 *   - `trello_connections` (token secret) is NOT readable by an authenticated
 *     member — only the service-role client.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';
// Encryption key for the pgcrypto token round-trip (U3).
const TOKEN_KEY = 'rls-trello-test-key-' + 'k'.repeat(40);

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
  describe.skip('trello sources RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Skipped: `supabase start` not running. Set RISEZOME_RUN_RLS_TESTS=1 to require.
    });
  });
} else {
  describe('generalized sources + trello_connections RLS', () => {
    let admin: SupabaseClient;
    let userA: TestUser;
    let orgA: string;
    let connectionId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      userA = await createTestUser(admin, 'rls-trello-a@example.com');
      orgA = await createOrgWithMember(admin, 'Trello Org A', userA.id, 'manager');

      // Token is stored encrypted (U3): encrypt via the pgcrypto helper first.
      const { data: tokEnc } = await admin.rpc('encrypt_refresh_token', {
        plaintext: 'tok_secret_abc',
        key: TOKEN_KEY,
      });
      const { data: conn, error: connErr } = await admin
        .from('trello_connections')
        .insert({
          org_id: orgA,
          token_enc: tokEnc as unknown as string,
          member_id: 'm1',
          username: 'acme',
        })
        .select('id')
        .single();
      if (connErr !== null || conn === null) {
        throw new Error(`failed to create trello_connection: ${connErr?.message ?? 'no row'}`);
      }
      connectionId = conn.id as string;
    });

    afterAll(async () => {
      await admin.auth.admin.deleteUser(userA.id).catch(() => undefined);
    });

    it('inserts a Trello source with no installation_id', async () => {
      const { data, error } = await admin
        .from('sources')
        .insert({
          org_id: orgA,
          kind: 'trello',
          connection_id: connectionId,
          external_id: 'board_123',
          display_name: 'Roadmap',
          status: 'pending',
        })
        .select('id, kind, installation_id')
        .single();
      expect(error).toBeNull();
      expect(data?.kind).toBe('trello');
      expect(data?.installation_id).toBeNull();
    });

    it('rejects a Trello source with no connection_id (per-kind identity check)', async () => {
      const { error } = await admin
        .from('sources')
        .insert({ org_id: orgA, kind: 'trello', external_id: 'board_x', status: 'pending' });
      expect(error).not.toBeNull();
    });

    it('rejects a GitHub source with no installation_id (per-kind identity check)', async () => {
      const { error } = await admin
        .from('sources')
        .insert({ org_id: orgA, kind: 'github', repo_full_name: 'acme/x', status: 'pending' });
      expect(error).not.toBeNull();
    });

    it('an org member reads their org Trello source via RLS', async () => {
      const { data, error } = await userA.client
        .from('sources')
        .select('id, kind, external_id')
        .eq('kind', 'trello');
      expect(error).toBeNull();
      expect((data ?? []).some((r) => r.external_id === 'board_123')).toBe(true);
    });

    it('a member CANNOT read trello_connections (service-role only)', async () => {
      const { data, error } = await userA.client.from('trello_connections').select('id');
      // RLS with no policy returns empty for the authenticated client (no error).
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    });

    it('stores the token encrypted at rest — no plaintext column, decrypt round-trips (U3)', async () => {
      const plaintextSel = await admin.from('trello_connections').select('token');
      expect(plaintextSel.error).not.toBeNull(); // plaintext column is gone

      const { data: row } = await admin
        .from('trello_connections')
        .select('token_enc')
        .eq('id', connectionId)
        .single();
      const dec = await admin.rpc('decrypt_refresh_token', {
        ciphertext: (row as { token_enc: string }).token_enc,
        key: TOKEN_KEY,
      });
      expect(dec.data).toBe('tok_secret_abc');
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
