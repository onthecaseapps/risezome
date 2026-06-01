/**
 * Manager-only config-write RLS tests (plan U4, R3): workspace_bot_settings
 * INSERT/UPDATE are gated on is_org_manager(). Same harness as orgs.test.ts;
 * auto-skips without a local Supabase stack unless RISEZOME_RUN_RLS_TESTS=1.
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
  describe.skip('manager-only config writes RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('manager-only config writes (workspace_bot_settings)', () => {
    let admin: SupabaseClient;
    let manager: TestUser;
    let member: TestUser;
    let orgId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      manager = await createTestUser(admin, 'rls-cfg-mgr@example.com');
      member = await createTestUser(admin, 'rls-cfg-mem@example.com');
      orgId = await createOrgWithMember(admin, 'Cfg Org', manager.id, 'manager');
      await addMember(admin, orgId, member.id, 'member', false);
      // Seed a settings row so UPDATE has a target.
      await admin.from('workspace_bot_settings').insert({ org_id: orgId, auto_join: false });
    });

    afterAll(async () => {
      await admin.auth.admin.deleteUser(manager.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
    });

    it('a member cannot UPDATE workspace bot settings', async () => {
      await member.client
        .from('workspace_bot_settings')
        .update({ auto_join: true })
        .eq('org_id', orgId);
      const { data } = await admin
        .from('workspace_bot_settings')
        .select('auto_join')
        .eq('org_id', orgId)
        .single();
      expect(data?.auto_join).toBe(false); // unchanged — RLS blocked the member
    });

    it('a manager can UPDATE workspace bot settings', async () => {
      const { error } = await manager.client
        .from('workspace_bot_settings')
        .update({ auto_join: true })
        .eq('org_id', orgId);
      expect(error).toBeNull();
      const { data } = await admin
        .from('workspace_bot_settings')
        .select('auto_join')
        .eq('org_id', orgId)
        .single();
      expect(data?.auto_join).toBe(true);
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
  await addMember(admin, org.id as string, userId, role, role === 'manager');
  return org.id as string;
}

async function addMember(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  role: 'manager' | 'member',
  canInviteBot: boolean,
): Promise<void> {
  const { error } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role, can_invite_bot: canInviteBot });
  if (error !== null) throw new Error(`Failed to add member: ${error.message}`);
}
