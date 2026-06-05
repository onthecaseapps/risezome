// @vitest-environment node
// Pure DB test — runs in real Node, not jsdom (see roles.test.ts).
/**
 * meeting_effective_source_ids RPC (plan U4; KTD5, B-R8/B-R9).
 *
 * A meeting's retrieval scope = the UNION of team_sources over the meeting's
 * ORG-MEMBER attendees' non-archived teams. Covers:
 *   - union across two attendees on two different teams
 *   - a non-org-member attendee contributes nothing
 *   - an archived team is excluded
 *   - a meeting whose attendees' teams have no sources resolves to the empty set
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';

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

async function rpcSet(admin: SupabaseClient, meetingId: string): Promise<string[]> {
  const { data, error } = await admin.rpc('meeting_effective_source_ids', { p_meeting_id: meetingId });
  if (error !== null) throw new Error(`rpc failed: ${error.message}`);
  return ((data as Array<{ meeting_effective_source_ids?: string } | string>) ?? [])
    .map((r) => (typeof r === 'string' ? r : (Object.values(r as object)[0] as string)))
    .sort();
}

if (!stackReachable && !FORCE) {
  describe.skip('meeting_effective_source_ids (stack not reachable)', () => {
    it('skipped', () => {});
  });
} else {
  describe('meeting_effective_source_ids — retrieval scope resolution', () => {
    let admin: SupabaseClient;
    let orgId: string;
    let userA: string;
    let userB: string;
    let guest: string; // attendee but NOT an org member
    let teamA: string;
    let teamB: string;
    let source1: string;
    let source2: string;
    let meetingId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      userA = await mkUser(admin, 'rls-mes-a@example.com');
      userB = await mkUser(admin, 'rls-mes-b@example.com');
      guest = await mkUser(admin, 'rls-mes-guest@example.com');

      orgId = (await admin.from('orgs').insert({ name: 'MES Org' }).select('id').single()).data!.id as string;
      await admin.from('org_members').insert([
        { org_id: orgId, user_id: userA, role: 'super_admin' },
        { org_id: orgId, user_id: userB, role: 'member' },
      ]);
      // guest is intentionally NOT an org member.

      teamA = await mkTeam(admin, orgId, 'A', 'team-a');
      teamB = await mkTeam(admin, orgId, 'B', 'team-b');
      await admin.from('team_members').insert([
        { team_id: teamA, user_id: userA },
        { team_id: teamB, user_id: userB },
      ]);

      await admin.from('github_installations').insert({
        installation_id: 9_100_001,
        org_id: orgId,
        account_login: 'acme',
        account_type: 'Organization',
      });
      source1 = await mkSource(admin, orgId, 'acme/one', 9_100_001);
      source2 = await mkSource(admin, orgId, 'acme/two', 9_100_001);
      await admin.from('team_sources').insert([
        { team_id: teamA, source_id: source1 },
        { team_id: teamB, source_id: source2 },
      ]);

      meetingId = (
        await admin
          .from('meetings')
          .insert({ org_id: orgId, user_id: userA, status: 'completed' })
          .select('meeting_id')
          .single()
      ).data!.meeting_id as string;
      // Attendees: userA (team A), userB (team B), and a non-member guest.
      await admin.from('meeting_participants').insert([
        { meeting_id: meetingId, user_id: userA },
        { meeting_id: meetingId, user_id: userB },
        { meeting_id: meetingId, user_id: guest },
      ]);
    });

    afterAll(async () => {
      await admin.from('orgs').delete().eq('id', orgId);
      for (const id of [userA, userB, guest]) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    });

    it('returns the UNION of both attendees\' teams\' sources (guest contributes nothing)', async () => {
      expect(await rpcSet(admin, meetingId)).toEqual([source1, source2].sort());
    });

    it('excludes an archived team\'s sources', async () => {
      await admin.from('teams').update({ archived_at: new Date().toISOString() }).eq('team_id', teamB);
      expect(await rpcSet(admin, meetingId)).toEqual([source1]);
      // restore
      await admin.from('teams').update({ archived_at: null }).eq('team_id', teamB);
    });

    it('resolves to the empty set when no attendee team has sources', async () => {
      // A fresh meeting whose only attendee is on a source-less team.
      const cId = await mkTeam(admin, orgId, 'C', 'team-c');
      await admin.from('team_members').insert({ team_id: cId, user_id: userB });
      const m2 = (
        await admin
          .from('meetings')
          .insert({ org_id: orgId, user_id: userB, status: 'completed' })
          .select('meeting_id')
          .single()
      ).data!.meeting_id as string;
      // userB is also on team B (has source2); to isolate "no sources", attend with
      // a member who is ONLY on the empty team C.
      const userC = await mkUser(admin, 'rls-mes-c@example.com');
      await admin.from('org_members').insert({ org_id: orgId, user_id: userC, role: 'member' });
      await admin.from('team_members').insert({ team_id: cId, user_id: userC });
      await admin.from('meetings').update({ user_id: userC }).eq('meeting_id', m2);
      await admin.from('meeting_participants').insert({ meeting_id: m2, user_id: userC });
      expect(await rpcSet(admin, m2)).toEqual([]);
      await admin.auth.admin.deleteUser(userC).catch(() => undefined);
    });
  });
}

async function mkUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: existing } = await admin.auth.admin.listUsers();
  const prior = existing?.users.find((u) => u.email === email);
  if (prior !== undefined) await admin.auth.admin.deleteUser(prior.id).catch(() => undefined);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `RlsTest_${Math.random().toString(36).slice(2)}!`,
    email_confirm: true,
  });
  if (error !== null || data.user === null) throw new Error(`mkUser ${email}: ${error?.message}`);
  return data.user.id;
}

async function mkTeam(admin: SupabaseClient, orgId: string, name: string, slug: string): Promise<string> {
  const { data, error } = await admin.from('teams').insert({ org_id: orgId, name, slug }).select('team_id').single();
  if (error !== null || data === null) throw new Error(`mkTeam ${slug}: ${error?.message}`);
  return data.team_id as string;
}

async function mkSource(
  admin: SupabaseClient,
  orgId: string,
  repo: string,
  installationId: number,
): Promise<string> {
  const { data, error } = await admin
    .from('sources')
    .insert({ org_id: orgId, kind: 'github', installation_id: installationId, repo_full_name: repo, status: 'idle' })
    .select('id')
    .single();
  if (error !== null || data === null) throw new Error(`mkSource ${repo}: ${error?.message}`);
  return data.id as string;
}
