// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom (the supabase-js realtime
// client's MessageEvent crashes jsdom's BroadcastChannel shim).
/**
 * permission_audit_log RLS + admin_override RPC tests (permissions overhaul U4/U5).
 *
 * Audit-log RLS (KTD6, Q4 — append-only, super-admin-readable):
 *   - a member CANNOT SELECT permission_audit_log (RLS deny)
 *   - an admin (manager) CANNOT SELECT it (deny — managers are NOT super_admins)
 *   - a super_admin CAN SELECT its org's rows (grant)
 *   - no client can INSERT a row via the anon client (no write policy)
 *   - no client can UPDATE / DELETE an existing row (append-only / immutable)
 *
 * admin_override_meeting_privacy RPC (U4, R12):
 *   - an admin can set a meeting BELOW the floor via the RPC (floor-exempt)
 *   - a NON-admin calling the RPC is rejected by the function's internal
 *     is_org_admin self-check (deny)
 *
 * Same harness shape as meeting-privacy.test.ts: real local Supabase stack;
 * auto-skips when unreachable unless RISEZOME_RUN_RLS_TESTS=1.
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
  describe.skip('permission_audit_log RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('permission_audit_log RLS + admin_override RPC', () => {
    let admin: SupabaseClient;
    let superAdmin: TestUser;
    let manager: TestUser;
    let member: TestUser;
    let orgId: string;
    let meetingId: string;
    let seededRowId: number;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      superAdmin = await createTestUser(admin, 'rls-audit-sa@example.com');
      manager = await createTestUser(admin, 'rls-audit-mgr@example.com');
      member = await createTestUser(admin, 'rls-audit-mem@example.com');

      orgId = await createOrgWithMember(admin, 'Audit Org', superAdmin.id, 'super_admin');
      await addMember(admin, orgId, manager.id, 'manager', true);
      await addMember(admin, orgId, member.id, 'member', false);
      await admin.from('org_privacy_config').insert({ org_id: orgId });

      // A meeting owned by the member (so the admin override acts on someone
      // else's meeting). Default privacy_level = only_teammates.
      const { data: m, error: mErr } = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: member.id, status: 'completed' })
        .select('meeting_id')
        .single();
      if (mErr !== null || m === null) {
        throw new Error(`Failed to create meeting: ${mErr?.message ?? 'no row'}`);
      }
      meetingId = m.meeting_id as string;

      // Seed one audit row (service-role) so SELECT/UPDATE/DELETE have a target.
      const { data: row, error: seedErr } = await admin
        .from('permission_audit_log')
        .insert({
          org_id: orgId,
          actor_id: superAdmin.id,
          action: 'privacy_change',
          target_meeting_id: meetingId,
          detail: { old: 'only_teammates', new: 'only_participants' },
        })
        .select('id')
        .single();
      if (seedErr !== null || row === null) {
        throw new Error(`Failed to seed audit row: ${seedErr?.message ?? 'no row'}`);
      }
      seededRowId = row.id as number;
    });

    afterAll(async () => {
      await admin.from('permission_audit_log').delete().eq('org_id', orgId);
      await admin.from('meetings').delete().eq('org_id', orgId);
      await admin.from('org_privacy_config').delete().eq('org_id', orgId);
      await admin.auth.admin.deleteUser(manager.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
      // super_admin org row deletion is blocked by the last-super_admin trigger
      // (documented residue; psql pre-clean clears the users + orphan orgs).
      await admin.auth.admin.deleteUser(superAdmin.id).catch(() => undefined);
    });

    // ── READ (RLS SELECT gated by is_super_admin) ────────────────────────────

    it('a member CANNOT read the audit log (deny)', async () => {
      const { data } = await member.client
        .from('permission_audit_log')
        .select('id')
        .eq('org_id', orgId);
      expect((data ?? []).length).toBe(0);
    });

    it('an admin (manager) CANNOT read the audit log — managers are not super_admins (deny)', async () => {
      const { data } = await manager.client
        .from('permission_audit_log')
        .select('id')
        .eq('org_id', orgId);
      expect((data ?? []).length).toBe(0);
    });

    it('a super_admin CAN read its org audit log (grant)', async () => {
      const { data, error } = await superAdmin.client
        .from('permission_audit_log')
        .select('id, action')
        .eq('org_id', orgId);
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    // ── WRITE (no client write policy: append-only, service-role-only) ───────

    it('no client can INSERT an audit row via the anon client (deny — no write policy)', async () => {
      // Even a super_admin (who can READ) has no INSERT policy.
      const { error } = await superAdmin.client.from('permission_audit_log').insert({
        org_id: orgId,
        actor_id: superAdmin.id,
        action: 'role_change',
        detail: { forged: true },
      });
      expect(error).not.toBeNull();
      // Verify no forged row landed (count unchanged via service-role).
      const { data } = await admin
        .from('permission_audit_log')
        .select('id')
        .eq('org_id', orgId)
        .contains('detail', { forged: true });
      expect((data ?? []).length).toBe(0);
    });

    it('a member cannot INSERT an audit row either (deny)', async () => {
      const { error } = await member.client.from('permission_audit_log').insert({
        org_id: orgId,
        actor_id: member.id,
        action: 'master_key_access',
      });
      expect(error).not.toBeNull();
    });

    it('an existing audit row cannot be UPDATEd via the anon client (immutable)', async () => {
      await superAdmin.client
        .from('permission_audit_log')
        .update({ detail: { tampered: true } })
        .eq('id', seededRowId);
      // The row's detail must be unchanged (verify via service-role).
      const { data } = await admin
        .from('permission_audit_log')
        .select('detail')
        .eq('id', seededRowId)
        .single();
      expect((data?.detail as Record<string, unknown>)?.['tampered']).toBeUndefined();
      expect((data?.detail as Record<string, unknown>)?.['new']).toBe('only_participants');
    });

    it('an existing audit row cannot be DELETEd via the anon client (append-only)', async () => {
      await superAdmin.client.from('permission_audit_log').delete().eq('id', seededRowId);
      const { data } = await admin
        .from('permission_audit_log')
        .select('id')
        .eq('id', seededRowId)
        .maybeSingle();
      expect(data).not.toBeNull(); // still present
    });

    // ── admin_override_meeting_privacy RPC (U4, R12) ─────────────────────────

    it('an admin can set a meeting BELOW the floor via the override RPC (floor-exempt)', async () => {
      // Raise the floor to only_participants so only_me is below-floor.
      await admin
        .from('org_privacy_config')
        .update({ privacy_floor: 'only_participants' })
        .eq('org_id', orgId);

      // super_admin (an admin) overrides the member's meeting to only_me.
      const { error } = await superAdmin.client.rpc('admin_override_meeting_privacy', {
        p_meeting_id: meetingId,
        p_level: 'only_me',
      });
      expect(error).toBeNull();

      const { data } = await admin
        .from('meetings')
        .select('privacy_level')
        .eq('meeting_id', meetingId)
        .single();
      expect(data?.privacy_level).toBe('only_me');
    });

    it('a NON-admin calling the override RPC is rejected by the internal self-check (deny)', async () => {
      // First restore the meeting to a known level via the admin override.
      await superAdmin.client.rpc('admin_override_meeting_privacy', {
        p_meeting_id: meetingId,
        p_level: 'only_participants',
      });

      const { error } = await member.client.rpc('admin_override_meeting_privacy', {
        p_meeting_id: meetingId,
        p_level: 'only_me',
      });
      expect(error).not.toBeNull();

      // The member's attempted below-floor override did NOT take effect.
      const { data } = await admin
        .from('meetings')
        .select('privacy_level')
        .eq('meeting_id', meetingId)
        .single();
      expect(data?.privacy_level).toBe('only_participants');
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
