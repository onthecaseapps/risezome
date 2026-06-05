// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel
// shim throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client, which
// would crash the worker and skip every test here (see roles.test.ts).
/**
 * RLS + helper tests for the teams restructure (plan U1).
 *
 * Covers:
 *   - members read teams / team_members of orgs they belong to; outsiders read none
 *   - is_team_member() is true only for an actual member of the team
 *   - no client write policy: a member cannot INSERT/UPDATE/DELETE teams or
 *     team_members via PostgREST (service-role-only writes, KTD8)
 *   - the default-team backfill seeds one "general" team per org with all members
 *   - the extended audit-action CHECK admits team_change / team_membership_change /
 *     gap_assignment and rejects an out-of-vocabulary action
 *
 * Same harness shape as roles.test.ts: real local Supabase stack via
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
  describe.skip('teams RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('teams + team_members RLS', () => {
    let admin: SupabaseClient;
    let superAdmin: TestUser;
    let member: TestUser;       // on teamA only
    let memberB: TestUser;      // on teamB only
    let outsider: TestUser;     // not in the org
    let orgId: string;
    let defaultTeamId: string;
    let teamAId: string;
    let teamBId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      superAdmin = await createTestUser(admin, 'rls-teams-sa@example.com');
      member = await createTestUser(admin, 'rls-teams-a@example.com');
      memberB = await createTestUser(admin, 'rls-teams-b@example.com');
      outsider = await createTestUser(admin, 'rls-teams-out@example.com');

      orgId = await createOrgWithMember(admin, 'Teams Org', superAdmin.id, 'super_admin');
      await addMember(admin, orgId, member.id, 'member');
      await addMember(admin, orgId, memberB.id, 'member');

      // The default-team backfill ran in the migration only for orgs that existed
      // at migration time. This org is created fresh by the test, so seed its
      // default team explicitly (mirrors what the U7 onboarding/create flow does).
      defaultTeamId = await createTeam(admin, orgId, 'General', 'general');
      await addAllOrgMembersToTeam(admin, orgId, defaultTeamId);

      teamAId = await createTeam(admin, orgId, 'Platform Eng', 'platform-eng');
      teamBId = await createTeam(admin, orgId, 'Growth', 'growth');
      await addTeamMember(admin, teamAId, member.id);
      await addTeamMember(admin, teamBId, memberB.id);
    });

    afterAll(async () => {
      await admin.from('orgs').delete().eq('id', orgId);
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(memberB.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(outsider.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(superAdmin.id).catch(() => undefined);
    });

    it('members read their org\'s teams; an outsider reads none', async () => {
      const asMember = await member.client.from('teams').select('team_id').eq('org_id', orgId);
      expect(asMember.error).toBeNull();
      const ids = (asMember.data ?? []).map((r) => r.team_id as string);
      expect(ids).toContain(defaultTeamId);
      expect(ids).toContain(teamAId);
      expect(ids).toContain(teamBId);

      const asOutsider = await outsider.client.from('teams').select('team_id').eq('org_id', orgId);
      expect(asOutsider.error).toBeNull();
      expect((asOutsider.data ?? []).length).toBe(0);
    });

    it('members read team_members for their org\'s teams; an outsider reads none', async () => {
      const asMember = await member.client.from('team_members').select('team_id, user_id');
      expect(asMember.error).toBeNull();
      const pairs = (asMember.data ?? []).map((r) => `${r.team_id}:${r.user_id}`);
      // Membership is org-scoped readability: a member of the org sees both teams' rows.
      expect(pairs).toContain(`${teamAId}:${member.id}`);
      expect(pairs).toContain(`${teamBId}:${memberB.id}`);

      const asOutsider = await outsider.client.from('team_members').select('team_id');
      expect(asOutsider.error).toBeNull();
      expect((asOutsider.data ?? []).length).toBe(0);
    });

    it('is_team_member() is true only for an actual member of the team', async () => {
      const aIsA = await member.client.rpc('is_team_member', { p_team_id: teamAId });
      expect(aIsA.error).toBeNull();
      expect(aIsA.data).toBe(true);

      const aIsB = await member.client.rpc('is_team_member', { p_team_id: teamBId });
      expect(aIsB.error).toBeNull();
      expect(aIsB.data).toBe(false);

      const outIsA = await outsider.client.rpc('is_team_member', { p_team_id: teamAId });
      expect(outIsA.error).toBeNull();
      expect(outIsA.data).toBe(false);
    });

    it('a member cannot INSERT/UPDATE/DELETE teams via PostgREST (no client write policy)', async () => {
      const ins = await member.client
        .from('teams')
        .insert({ org_id: orgId, name: 'Rogue', slug: 'rogue' })
        .select('team_id');
      // Either an RLS error or zero rows inserted — verify nothing landed.
      const check = await admin.from('teams').select('team_id').eq('org_id', orgId).eq('slug', 'rogue');
      expect((check.data ?? []).length).toBe(0);
      expect(ins.data ?? []).toEqual([]);

      await member.client.from('teams').update({ name: 'Hacked' }).eq('team_id', teamAId);
      const renamed = await admin.from('teams').select('name').eq('team_id', teamAId).single();
      expect(renamed.data?.name).toBe('Platform Eng');

      await member.client.from('teams').delete().eq('team_id', teamBId);
      const stillThere = await admin.from('teams').select('team_id').eq('team_id', teamBId).single();
      expect(stillThere.data?.team_id).toBe(teamBId);
    });

    it('a member cannot add themselves to a team via PostgREST (no client write policy)', async () => {
      await member.client.from('team_members').insert({ team_id: teamBId, user_id: member.id });
      const check = await admin
        .from('team_members')
        .select('user_id')
        .eq('team_id', teamBId)
        .eq('user_id', member.id);
      expect((check.data ?? []).length).toBe(0);
    });

    it('the default-team backfill shape: one "general" team per org holding all members', async () => {
      const { data, error } = await admin
        .from('teams')
        .select('team_id')
        .eq('org_id', orgId)
        .eq('slug', 'general');
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);

      const members = await admin
        .from('team_members')
        .select('user_id')
        .eq('team_id', defaultTeamId);
      const ids = (members.data ?? []).map((r) => r.user_id as string);
      expect(ids).toContain(superAdmin.id);
      expect(ids).toContain(member.id);
      expect(ids).toContain(memberB.id);
    });

    it('the audit-action CHECK admits the new team/gap actions and rejects unknowns', async () => {
      for (const action of ['team_change', 'team_membership_change', 'gap_assignment']) {
        const { error } = await admin
          .from('permission_audit_log')
          .insert({ org_id: orgId, actor_id: superAdmin.id, action, detail: {} });
        expect(error, `action ${action} should be accepted`).toBeNull();
      }
      const bad = await admin
        .from('permission_audit_log')
        .insert({ org_id: orgId, actor_id: superAdmin.id, action: 'not_a_real_action' });
      expect(bad.error).not.toBeNull();
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
  await addMember(admin, org.id as string, userId, role);
  return org.id as string;
}

async function addMember(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  role: TestRole,
): Promise<void> {
  const { error } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role });
  if (error !== null) {
    throw new Error(`Failed to add member: ${error.message}`);
  }
}

async function createTeam(
  admin: SupabaseClient,
  orgId: string,
  name: string,
  slug: string,
): Promise<string> {
  const { data, error } = await admin
    .from('teams')
    .insert({ org_id: orgId, name, slug })
    .select('team_id')
    .single();
  if (error !== null || data === null) {
    throw new Error(`Failed to create team ${slug}: ${error?.message ?? 'no row'}`);
  }
  return data.team_id as string;
}

async function addTeamMember(admin: SupabaseClient, teamId: string, userId: string): Promise<void> {
  const { error } = await admin.from('team_members').insert({ team_id: teamId, user_id: userId });
  if (error !== null) {
    throw new Error(`Failed to add team member: ${error.message}`);
  }
}

async function addAllOrgMembersToTeam(
  admin: SupabaseClient,
  orgId: string,
  teamId: string,
): Promise<void> {
  const { data } = await admin.from('org_members').select('user_id').eq('org_id', orgId);
  for (const row of data ?? []) {
    // PostgREST builders are thenables without .catch — errors surface on `error`,
    // which we intentionally ignore here (idempotent seed).
    await admin.from('team_members').insert({ team_id: teamId, user_id: row.user_id as string });
  }
}
