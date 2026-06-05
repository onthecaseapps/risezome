// @vitest-environment node
// Pure DB/RLS + lifecycle test — runs in real Node, not jsdom (see roles.test.ts).
/**
 * team_sources RLS + reference-counted lifecycle (plan U3).
 *
 * Covers:
 *   - members read team_sources for their org's teams; outsiders read none
 *   - no client write policy: a member cannot INSERT/DELETE team_sources (KTD8)
 *   - reference-count semantics: one source selected by two teams is one source
 *     row with refcount 2; dropping one leaves refcount 1
 *   - the lifecycle lib (addSourceToTeam / removeSourceFromTeam): first reference
 *     of a never-indexed source revives it (status='pending') and emits ONE index
 *     event; a second team selecting it emits NO event (dedup — KTD4); the last
 *     drop marks the source 'removed' (de-index handed to the purge cron)
 *
 * Inngest is mocked so no dev server is required. Same skip-guard harness shape
 * as roles.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';

// The lifecycle lib resolves the service-role client from SUPABASE_SECRET_KEY.
if (process.env['SUPABASE_SECRET_KEY'] === undefined && SUPABASE_SERVICE_ROLE_KEY !== '') {
  process.env['SUPABASE_SECRET_KEY'] = SUPABASE_SERVICE_ROLE_KEY;
}

// Mock the Inngest client so addSourceToTeam's index dispatch is captured, not sent.
const sentEvents: Array<{ name: string; data: unknown }> = [];
vi.mock('../../src/inngest/client', () => ({
  inngest: {
    send: async (evt: { name: string; data: unknown }) => {
      sentEvents.push(evt);
      return { ids: ['mock'] };
    },
  },
}));

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe).
const { addSourceToTeam, removeSourceFromTeam } = await import('../../app/_lib/team-source-lifecycle');

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
  describe.skip('team_sources (Supabase stack not reachable)', () => {
    it('skipped', () => {});
  });
} else {
  describe('team_sources RLS + reference-counted lifecycle', () => {
    let admin: SupabaseClient;
    let member: TestUser;
    let outsider: TestUser;
    let orgId: string;
    let teamA: string;
    let teamB: string;
    let sourceId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      member = await createTestUser(admin, 'rls-ts-mem@example.com');
      outsider = await createTestUser(admin, 'rls-ts-out@example.com');
      orgId = await createOrgWithMember(admin, 'TS Org', member.id, 'super_admin');

      teamA = await createTeam(admin, orgId, 'Team A', 'team-a');
      teamB = await createTeam(admin, orgId, 'Team B', 'team-b');
      await admin.from('team_members').insert({ team_id: teamA, user_id: member.id });

      // A never-indexed github source row to drive the lifecycle (kind=github uses
      // the generic source.index-requested event). Needs a parent installation row.
      await admin.from('github_installations').insert({
        installation_id: 9_000_001,
        org_id: orgId,
        account_login: 'acme',
        account_type: 'Organization',
      });
      const { data: src, error } = await admin
        .from('sources')
        .insert({
          org_id: orgId,
          kind: 'github',
          installation_id: 9_000_001,
          repo_full_name: 'acme/ts-test',
          status: 'pending',
        })
        .select('id')
        .single();
      if (error !== null || src === null) throw new Error(`seed source failed: ${error?.message}`);
      sourceId = src.id as string;
    });

    afterAll(async () => {
      await admin.from('orgs').delete().eq('id', orgId);
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(outsider.id).catch(() => undefined);
    });

    it('first reference revives + indexes a never-indexed source (one event)', async () => {
      sentEvents.length = 0;
      const r = await addSourceToTeam({ orgId, teamId: teamA, sourceId });
      expect(r.indexed).toBe(true);
      expect(sentEvents).toHaveLength(1);
      expect(sentEvents[0]?.name).toBe('risezome/source.index-requested');

      const { data } = await admin.from('sources').select('status').eq('id', sourceId).single();
      expect(data?.status).toBe('pending');
      const refs = await admin
        .from('team_sources')
        .select('team_id', { count: 'exact', head: true })
        .eq('source_id', sourceId);
      expect(refs.count).toBe(1);
    });

    it('a second team selecting the same source emits NO index event (dedup)', async () => {
      // Simulate the source having finished indexing.
      await admin.from('sources').update({ status: 'idle', last_indexed_at: new Date().toISOString() }).eq('id', sourceId);
      sentEvents.length = 0;
      const r = await addSourceToTeam({ orgId, teamId: teamB, sourceId });
      expect(r.indexed).toBe(false);
      expect(sentEvents).toHaveLength(0);
      const refs = await admin
        .from('team_sources')
        .select('team_id', { count: 'exact', head: true })
        .eq('source_id', sourceId);
      expect(refs.count).toBe(2);
    });

    it('members read team_sources for their org; an outsider reads none', async () => {
      const asMember = await member.client.from('team_sources').select('source_id').eq('source_id', sourceId);
      expect(asMember.error).toBeNull();
      expect((asMember.data ?? []).length).toBe(2);

      const asOutsider = await outsider.client.from('team_sources').select('source_id');
      expect(asOutsider.error).toBeNull();
      expect((asOutsider.data ?? []).length).toBe(0);
    });

    it('a member cannot write team_sources via PostgREST (no client write policy)', async () => {
      await member.client.from('team_sources').delete().eq('team_id', teamA).eq('source_id', sourceId);
      const check = await admin
        .from('team_sources')
        .select('team_id', { count: 'exact', head: true })
        .eq('source_id', sourceId);
      expect(check.count).toBe(2); // unchanged
    });

    it('dropping one team leaves refcount 1 and does NOT de-index', async () => {
      const r = await removeSourceFromTeam({ orgId, teamId: teamA, sourceId });
      expect(r.deindexed).toBe(false);
      const { data } = await admin.from('sources').select('status, removed_at').eq('id', sourceId).single();
      expect(data?.status).toBe('idle');
      expect(data?.removed_at).toBeNull();
    });

    it('the last drop marks the source removed (de-index via purge cron)', async () => {
      const r = await removeSourceFromTeam({ orgId, teamId: teamB, sourceId });
      expect(r.deindexed).toBe(true);
      const { data } = await admin.from('sources').select('status, removed_at').eq('id', sourceId).single();
      expect(data?.status).toBe('removed');
      expect(data?.removed_at).not.toBeNull();
      const refs = await admin
        .from('team_sources')
        .select('team_id', { count: 'exact', head: true })
        .eq('source_id', sourceId);
      expect(refs.count).toBe(0);
    });
  });
}

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

async function createTestUser(admin: SupabaseClient, email: string): Promise<TestUser> {
  const password = `RlsTest_${Math.random().toString(36).slice(2)}!`;
  const { data: existing } = await admin.auth.admin.listUsers();
  const prior = existing?.users.find((u) => u.email === email);
  if (prior !== undefined) await admin.auth.admin.deleteUser(prior.id).catch(() => undefined);
  const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error !== null || created.user === null) {
    throw new Error(`Failed to create test user ${email}: ${error?.message ?? 'no user'}`);
  }
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr !== null) throw new Error(`Failed to sign in ${email}: ${signInErr.message}`);
  return { id: created.user.id, email, client };
}

async function createOrgWithMember(
  admin: SupabaseClient,
  orgName: string,
  userId: string,
  role: 'super_admin' | 'manager' | 'member',
): Promise<string> {
  const { data: org, error } = await admin.from('orgs').insert({ name: orgName }).select('id').single();
  if (error !== null || org === null) throw new Error(`Failed to create org: ${error?.message}`);
  await admin.from('org_members').insert({ org_id: org.id as string, user_id: userId, role });
  return org.id as string;
}

async function createTeam(admin: SupabaseClient, orgId: string, name: string, slug: string): Promise<string> {
  const { data, error } = await admin.from('teams').insert({ org_id: orgId, name, slug }).select('team_id').single();
  if (error !== null || data === null) throw new Error(`Failed to create team ${slug}: ${error?.message}`);
  return data.team_id as string;
}
