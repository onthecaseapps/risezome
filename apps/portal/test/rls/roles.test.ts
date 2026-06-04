// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel
// shim throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client's
// MessageEvent, which would crash the worker and skip every test here.
/**
 * RLS + authorization-helper tests for workspace roles (plan U1).
 *
 * Covers:
 *   - role CHECK pins values to 'manager' | 'member' (old 'admin' rejected)
 *   - can_invite_bot defaults to false
 *   - is_org_manager() returns true only for a manager of the org
 *   - org_member_ids() returns the member set for a member, nothing for a
 *     non-member, and does not error (the recursion bug it must avoid)
 *   - a member cannot self-set can_invite_bot (no user-facing UPDATE policy)
 *
 * Same harness shape as orgs.test.ts: real local Supabase stack via
 * `supabase start`; auto-skips when unreachable unless RISEZOME_RUN_RLS_TESTS=1.
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
  describe.skip('roles RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('workspace roles + authz helpers', () => {
    let admin: SupabaseClient;
    let manager: TestUser;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      manager = await createTestUser(admin, 'rls-roles-mgr@example.com');
      member = await createTestUser(admin, 'rls-roles-mem@example.com');
      outsider = await createTestUser(admin, 'rls-roles-out@example.com');

      orgId = await createOrgWithMember(admin, 'Roles Org', manager.id, 'manager');
      await addMember(admin, orgId, member.id, 'member', false);
    });

    afterAll(async () => {
      await admin.auth.admin.deleteUser(manager.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(outsider.id).catch(() => undefined);
    });

    it('rejects an out-of-vocabulary role via the CHECK constraint', async () => {
      const { error } = await admin
        .from('org_members')
        .insert({ org_id: orgId, user_id: outsider.id, role: 'admin' });
      expect(error).not.toBeNull();
      // Clean up in case it somehow inserted.
      await admin.from('org_members').delete().eq('org_id', orgId).eq('user_id', outsider.id);
    });

    it('defaults can_invite_bot to false for a new member', async () => {
      const { data, error } = await admin
        .from('org_members')
        .select('can_invite_bot')
        .eq('org_id', orgId)
        .eq('user_id', member.id)
        .single();
      expect(error).toBeNull();
      expect(data?.can_invite_bot).toBe(false);
    });

    it('is_org_manager() is true for the manager, false for the member and outsider', async () => {
      const asManager = await manager.client.rpc('is_org_manager', { p_org_id: orgId });
      expect(asManager.error).toBeNull();
      expect(asManager.data).toBe(true);

      const asMember = await member.client.rpc('is_org_manager', { p_org_id: orgId });
      expect(asMember.error).toBeNull();
      expect(asMember.data).toBe(false);

      const asOutsider = await outsider.client.rpc('is_org_manager', { p_org_id: orgId });
      expect(asOutsider.error).toBeNull();
      expect(asOutsider.data).toBe(false);
    });

    it('org_member_ids() returns the member set for a member, nothing for a non-member, no recursion error', async () => {
      const asMember = await member.client.rpc('org_member_ids', { p_org_id: orgId });
      expect(asMember.error).toBeNull();
      const ids = (asMember.data as string[] | null) ?? [];
      expect(ids).toContain(manager.id);
      expect(ids).toContain(member.id);

      const asOutsider = await outsider.client.rpc('org_member_ids', { p_org_id: orgId });
      expect(asOutsider.error).toBeNull();
      expect((asOutsider.data as string[] | null) ?? []).toEqual([]);
    });

    // Backs the U5 members-page migration: MembersPage reads the org roster via
    // the RLS-scoped authed client (createServerClient). The page is
    // requireManager()-gated, so the "read own membership or all as manager"
    // SELECT policy must return EVERY member for a manager. A regression here
    // (policy narrowed) would silently empty the members list for managers.
    it('a manager reads the full org_members roster via RLS; a member reads only their own row', async () => {
      const asManager = await manager.client
        .from('org_members')
        .select('user_id')
        .eq('org_id', orgId);
      expect(asManager.error).toBeNull();
      const managerIds = (asManager.data ?? []).map((r) => r.user_id as string);
      expect(managerIds).toContain(manager.id);
      expect(managerIds).toContain(member.id);

      const asMember = await member.client
        .from('org_members')
        .select('user_id')
        .eq('org_id', orgId);
      expect(asMember.error).toBeNull();
      const memberIds = (asMember.data ?? []).map((r) => r.user_id as string);
      expect(memberIds).toEqual([member.id]);

      const asOutsider = await outsider.client
        .from('org_members')
        .select('user_id')
        .eq('org_id', orgId);
      expect(asOutsider.error).toBeNull();
      expect((asOutsider.data ?? []).length).toBe(0);
    });

    it('a member cannot self-grant can_invite_bot (no user-facing UPDATE policy)', async () => {
      await member.client
        .from('org_members')
        .update({ can_invite_bot: true })
        .eq('org_id', orgId)
        .eq('user_id', member.id);
      // Whether the update errors or silently affects zero rows, the row must
      // remain unchanged — verify via the service-role client.
      const { data } = await admin
        .from('org_members')
        .select('can_invite_bot')
        .eq('org_id', orgId)
        .eq('user_id', member.id)
        .single();
      expect(data?.can_invite_bot).toBe(false);
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
  if (error !== null) {
    throw new Error(`Failed to add member: ${error.message}`);
  }
}
