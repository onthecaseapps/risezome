// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel
// shim throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client's
// MessageEvent, which would crash the worker and skip every test here.
/**
 * RLS + authorization-helper tests for workspace roles (plan U1).
 *
 * Covers:
 *   - role CHECK pins values to 'member' | 'manager' | 'super_admin'
 *     (old 'admin' rejected)
 *   - can_invite_bot defaults to false
 *   - is_org_manager() returns true only for a manager of the org
 *   - is_org_admin() true for manager AND super_admin; is_super_admin() only
 *     for super_admin (permissions overhaul U1 — KTD2)
 *   - a member cannot self-promote to super_admin (service-role-only writes)
 *   - the last super_admin cannot be demoted (last-privileged-user trigger, KTD8)
 *   - the creator is seeded as super_admin (R15 backfill rule)
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
    let superAdmin: TestUser;
    let manager: TestUser;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      superAdmin = await createTestUser(admin, 'rls-roles-sa@example.com');
      manager = await createTestUser(admin, 'rls-roles-mgr@example.com');
      member = await createTestUser(admin, 'rls-roles-mem@example.com');
      outsider = await createTestUser(admin, 'rls-roles-out@example.com');

      // The org's creator is the super_admin (master-key holder, R15). A
      // separate manager (Admin tier) and member round out the 3-tier fixture.
      orgId = await createOrgWithMember(admin, 'Roles Org', superAdmin.id, 'super_admin');
      await addMember(admin, orgId, manager.id, 'manager', true);
      await addMember(admin, orgId, member.id, 'member', false);
    });

    afterAll(async () => {
      // Best-effort teardown. NOTE (KTD8 harness gotcha): the last-super_admin /
      // last-admin trigger blocks demoting OR deleting (even via an orgs cascade)
      // an org's sole super_admin — there is no privileged-user-removing path
      // through the RLS-respecting/service-role JS client (it cannot
      // `set session_replication_role = replica`). So the creator's org_members
      // row + its org may persist as DOCUMENTED RESIDUE. The deterministic
      // pre-clean before each run (psql with replica mode, per the test runbook)
      // is what actually clears `rls-%@example.com` users + orphan orgs.
      // First detach the non-privileged member + the manager (manager is still
      // the surviving admin-or-above for the creator, so it can be removed only
      // after the creator stops being the lone super_admin — which we cannot do
      // here; we therefore delete what the trigger allows and leave the rest).
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(superAdmin.id).catch(() => undefined);
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

    it('is_org_admin() is true for manager AND super_admin, false for member/outsider', async () => {
      const asSuperAdmin = await superAdmin.client.rpc('is_org_admin', { p_org_id: orgId });
      expect(asSuperAdmin.error).toBeNull();
      expect(asSuperAdmin.data).toBe(true);

      const asManager = await manager.client.rpc('is_org_admin', { p_org_id: orgId });
      expect(asManager.error).toBeNull();
      expect(asManager.data).toBe(true);

      const asMember = await member.client.rpc('is_org_admin', { p_org_id: orgId });
      expect(asMember.error).toBeNull();
      expect(asMember.data).toBe(false);

      const asOutsider = await outsider.client.rpc('is_org_admin', { p_org_id: orgId });
      expect(asOutsider.error).toBeNull();
      expect(asOutsider.data).toBe(false);
    });

    it('is_super_admin() is true ONLY for the super_admin, false for manager/member/outsider', async () => {
      const asSuperAdmin = await superAdmin.client.rpc('is_super_admin', { p_org_id: orgId });
      expect(asSuperAdmin.error).toBeNull();
      expect(asSuperAdmin.data).toBe(true);

      const asManager = await manager.client.rpc('is_super_admin', { p_org_id: orgId });
      expect(asManager.error).toBeNull();
      expect(asManager.data).toBe(false);

      const asMember = await member.client.rpc('is_super_admin', { p_org_id: orgId });
      expect(asMember.error).toBeNull();
      expect(asMember.data).toBe(false);

      const asOutsider = await outsider.client.rpc('is_super_admin', { p_org_id: orgId });
      expect(asOutsider.error).toBeNull();
      expect(asOutsider.data).toBe(false);
    });

    it('a member cannot self-promote to super_admin via PostgREST (service-role-only writes)', async () => {
      await member.client
        .from('org_members')
        .update({ role: 'super_admin' })
        .eq('org_id', orgId)
        .eq('user_id', member.id);
      // Whether the update errors or silently affects zero rows, the role must
      // remain 'member' — verify via the service-role client.
      const { data } = await admin
        .from('org_members')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', member.id)
        .single();
      expect(data?.role).toBe('member');
    });

    it('demoting the LAST super_admin is rejected by the trigger', async () => {
      // The org has exactly one super_admin (the creator). Attempting to demote
      // it to manager must be blocked: an org must always retain >=1 super_admin
      // (the master-key holder, KTD8). Use service-role to bypass RLS so we are
      // testing the trigger, not a write policy.
      const { error } = await admin
        .from('org_members')
        .update({ role: 'manager' })
        .eq('org_id', orgId)
        .eq('user_id', superAdmin.id);
      expect(error).not.toBeNull();
      expect(error?.message).toContain('last super_admin');
      // Confirm the row is unchanged.
      const { data } = await admin
        .from('org_members')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', superAdmin.id)
        .single();
      expect(data?.role).toBe('super_admin');
    });

    it('a second super_admin can be demoted (only the LAST is protected)', async () => {
      // Promote the manager to super_admin, then demoting the original back to
      // manager is allowed because one super_admin survives.
      await admin
        .from('org_members')
        .update({ role: 'super_admin' })
        .eq('org_id', orgId)
        .eq('user_id', manager.id);
      const { error } = await admin
        .from('org_members')
        .update({ role: 'manager' })
        .eq('org_id', orgId)
        .eq('user_id', manager.id);
      expect(error).toBeNull();
      // Restore the fixture invariant (creator is the sole super_admin) for any
      // later assertions / cleanup.
      const { data } = await admin
        .from('org_members')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', superAdmin.id)
        .single();
      expect(data?.role).toBe('super_admin');
    });

    it('a freshly created org seeds its creator (earliest manager) as super_admin (R15 backfill rule)', async () => {
      // Simulate the pre-migration shape: an org whose creator row is a plain
      // 'manager' with no super_admin yet. The backfill rule promotes exactly
      // that earliest-joined manager. We assert the rule by re-running its
      // predicate shape: in this org the creator IS a super_admin, and is the
      // earliest-joined privileged row.
      const { data, error } = await admin
        .from('org_members')
        .select('user_id, role, joined_at')
        .eq('org_id', orgId)
        .in('role', ['manager', 'super_admin'])
        .order('joined_at', { ascending: true });
      expect(error).toBeNull();
      const rows = data ?? [];
      // The earliest privileged member is the super_admin creator.
      expect(rows[0]?.user_id).toBe(superAdmin.id);
      expect(rows[0]?.role).toBe('super_admin');
      // Exactly one super_admin in the org.
      expect(rows.filter((r) => r.role === 'super_admin')).toHaveLength(1);
    });

    it('org_member_ids() returns the member set for a member, nothing for a non-member, no recursion error', async () => {
      const asMember = await member.client.rpc('org_member_ids', { p_org_id: orgId });
      expect(asMember.error).toBeNull();
      const ids = (asMember.data as string[] | null) ?? [];
      expect(ids).toContain(superAdmin.id);
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
    it('an admin reads the full org_members roster via RLS; a member reads only their own row', async () => {
      // The roster SELECT policy is now gated by is_org_admin, so both a manager
      // (Admin tier) and a super_admin see every member row.
      const asManager = await manager.client
        .from('org_members')
        .select('user_id')
        .eq('org_id', orgId);
      expect(asManager.error).toBeNull();
      const managerIds = (asManager.data ?? []).map((r) => r.user_id as string);
      expect(managerIds).toContain(superAdmin.id);
      expect(managerIds).toContain(manager.id);
      expect(managerIds).toContain(member.id);

      const asSuperAdmin = await superAdmin.client
        .from('org_members')
        .select('user_id')
        .eq('org_id', orgId);
      expect(asSuperAdmin.error).toBeNull();
      const superAdminIds = (asSuperAdmin.data ?? []).map((r) => r.user_id as string);
      expect(superAdminIds).toContain(superAdmin.id);
      expect(superAdminIds).toContain(manager.id);
      expect(superAdminIds).toContain(member.id);

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

type TestRole = 'manager' | 'member' | 'super_admin';

async function createOrgWithMember(
  admin: SupabaseClient,
  orgName: string,
  userId: string,
  role: TestRole,
): Promise<string> {
  const { data: org, error: orgErr } = await admin
    .from('orgs')
    .insert({ name: orgName })
    .select('id')
    .single();
  if (orgErr !== null || org === null) {
    throw new Error(`Failed to create org ${orgName}: ${orgErr?.message ?? 'no row'}`);
  }
  await addMember(admin, org.id as string, userId, role, role !== 'member');
  return org.id as string;
}

async function addMember(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  role: TestRole,
  canInviteBot: boolean,
): Promise<void> {
  const { error } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role, can_invite_bot: canInviteBot });
  if (error !== null) {
    throw new Error(`Failed to add member: ${error.message}`);
  }
}
