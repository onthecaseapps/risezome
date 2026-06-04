// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel
// shim throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client's
// MessageEvent, which would crash the worker and skip every test here.
/**
 * Meeting-privacy schema + floor-trigger tests (permissions overhaul U2).
 *
 * Covers:
 *   - a direct PostgREST UPDATE of meetings.privacy_level to a BELOW-FLOOR level
 *     is rejected by the floor trigger (deny; R9/R10)
 *   - setting privacy_level AT or ABOVE the floor succeeds
 *   - the floor-bypass GUC works: a transaction that
 *     `set local app.bypass_privacy_floor='on'` may set a below-floor level
 *     (this is what U4's admin override uses)
 *   - org_privacy_config is NOT client-writable (no client write policy; KTD6)
 *   - org_privacy_config IS readable by an org member (SELECT policy)
 *   - existing/new meetings default to privacy_level='only_teammates' (R14)
 *
 * Same harness shape as roles.test.ts: real local Supabase stack; auto-skips
 * when unreachable unless RISEZOME_RUN_RLS_TESTS=1. The floor-trigger + GUC
 * assertions go through a direct pg connection (the JS client cannot issue
 * `set local` inside the same transaction as a write); the RLS-policy assertions
 * go through anon clients.
 */

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const DB_URL =
  process.env['SUPABASE_DB_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';

/**
 * Run a SQL statement through psql against the local stack. Used only for the
 * floor-bypass GUC assertion, which needs `set local app.bypass_privacy_floor`
 * + a write in the SAME transaction — something the supabase-js/PostgREST
 * client cannot express. Returns combined stdout; throws on a non-zero exit
 * (e.g. when the floor trigger rejects the write).
 */
function psql(sql: string): string {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-tc', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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
  describe.skip('meeting-privacy RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('meeting privacy schema + floor trigger', () => {
    let admin: SupabaseClient;
    let superAdmin: TestUser;
    let member: TestUser;
    let orgId: string;
    let meetingId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      superAdmin = await createTestUser(admin, 'rls-priv-sa@example.com');
      member = await createTestUser(admin, 'rls-priv-mem@example.com');

      orgId = await createOrgWithMember(admin, 'Privacy Org', superAdmin.id, 'super_admin');
      await addMember(admin, orgId, member.id, 'member', false);

      // The migration only seeds config for orgs existing at migrate time; this
      // org was created after, so seed its config row explicitly (mirrors what
      // the U4 onboarding/config action will do). Floor starts permissive
      // (only_me); individual tests raise it as needed.
      await admin.from('org_privacy_config').insert({ org_id: orgId });

      // A meeting owned by the super_admin (owner = user_id). No conference_url
      // is required for the privacy tests.
      const { data: m, error: mErr } = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: superAdmin.id, status: 'completed' })
        .select('meeting_id, privacy_level')
        .single();
      if (mErr !== null || m === null) {
        throw new Error(`Failed to create meeting: ${mErr?.message ?? 'no row'}`);
      }
      meetingId = m.meeting_id as string;
    });

    afterAll(async () => {
      await admin.from('meetings').delete().eq('org_id', orgId);
      await admin.from('org_privacy_config').delete().eq('org_id', orgId);
      // Best-effort: cleanup of the super_admin org row is blocked by the
      // last-super_admin trigger (documented residue; the psql pre-clean is what
      // actually clears rls-%@example.com users + orphan orgs).
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(superAdmin.id).catch(() => undefined);
    });

    it('a new meeting defaults to privacy_level=only_teammates (R14)', async () => {
      const { data, error } = await admin
        .from('meetings')
        .select('privacy_level')
        .eq('meeting_id', meetingId)
        .single();
      expect(error).toBeNull();
      expect(data?.privacy_level).toBe('only_teammates');
    });

    it('setting privacy_level at-or-above the floor succeeds', async () => {
      // Floor is only_me (rank 0); only_participants (rank 1) is >= floor.
      const { error } = await admin
        .from('meetings')
        .update({ privacy_level: 'only_participants' })
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId);
      expect(error).toBeNull();
      const { data } = await admin
        .from('meetings')
        .select('privacy_level')
        .eq('meeting_id', meetingId)
        .single();
      expect(data?.privacy_level).toBe('only_participants');
    });

    it('a below-floor UPDATE is rejected by the floor trigger (deny; R9/R10)', async () => {
      // Raise the floor to only_participants, then try to set only_me (more
      // private than the floor) — the trigger must reject it.
      await admin
        .from('org_privacy_config')
        .update({ privacy_floor: 'only_participants' })
        .eq('org_id', orgId);

      const { error } = await admin
        .from('meetings')
        .update({ privacy_level: 'only_me' })
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId);
      expect(error).not.toBeNull();
      expect(error?.message).toContain('more private than the org floor');

      // Row unchanged.
      const { data } = await admin
        .from('meetings')
        .select('privacy_level')
        .eq('meeting_id', meetingId)
        .single();
      expect(data?.privacy_level).toBe('only_participants');
    });

    it('the floor-bypass GUC lets a below-floor UPDATE through (U4 admin override)', () => {
      // Floor is only_participants (from the deny test). Within one tx that
      // sets app.bypass_privacy_floor='on', setting only_me must succeed — this
      // is exactly the mechanism U4's admin override uses. `set local` confines
      // the override to the transaction.
      psql(
        `begin;
         set local app.bypass_privacy_floor = 'on';
         update public.meetings set privacy_level = 'only_me'
           where meeting_id = '${meetingId}' and org_id = '${orgId}';
         commit;`,
      );
      const after = psql(
        `select privacy_level from public.meetings where meeting_id = '${meetingId}';`,
      ).trim();
      expect(after).toBe('only_me');

      // The GUC is transaction-local: WITHOUT it the floor is enforced again.
      // Move the row back up (via the bypass), then a plain below-floor write
      // must be REJECTED.
      psql(
        `begin;
         set local app.bypass_privacy_floor = 'on';
         update public.meetings set privacy_level = 'only_participants'
           where meeting_id = '${meetingId}';
         commit;`,
      );
      let rejected = false;
      try {
        psql(
          `update public.meetings set privacy_level = 'only_me'
             where meeting_id = '${meetingId}';`,
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    });

    it('org_privacy_config is readable by an org member (SELECT policy)', async () => {
      const { data, error } = await member.client
        .from('org_privacy_config')
        .select('default_privacy, privacy_floor')
        .eq('org_id', orgId);
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);
      expect(data?.[0]?.default_privacy).toBe('only_teammates');
    });

    it('a member cannot client-write org_privacy_config (no client write policy; KTD6)', async () => {
      await member.client
        .from('org_privacy_config')
        .update({ privacy_floor: 'only_teammates' })
        .eq('org_id', orgId);
      // Whether it errors or affects zero rows, the floor must be unchanged
      // (still only_participants from the deny test) — verify via service-role.
      const { data } = await admin
        .from('org_privacy_config')
        .select('privacy_floor')
        .eq('org_id', orgId)
        .single();
      expect(data?.privacy_floor).toBe('only_participants');
    });
  });

  /**
   * Privacy-aware RLS access matrix (permissions overhaul U3; KTD3/KTD4).
   *
   * Seeds ONE org with six personas and one meeting, then drives the meeting's
   * privacy_level across all three levels, asserting via each persona's anon
   * (RLS) client whether they can SELECT the `meetings` row:
   *
   *   persona               only_me   only_participants   only_teammates
   *   owner (launcher)       YES        YES                 YES
   *   participant-teammate   NO         YES                 YES
   *   nonparticipant-team    NO         NO                  YES
   *   admin (manager)        NO         NO                  YES
   *   super_admin            YES        YES                 YES   (master key)
   *   outsider (other org)   NO         NO                  NO
   *
   * [AE1/AE5] only_me hides the meeting from everyone but owner + super_admin.
   * [AE6] only_participants is participant-scoped (degenerate all-external =
   *       owner-only). [AE2] only_teammates is org-wide. The owner here is a
   *       PLAIN member (not the super_admin) so "owner YES" is distinguishable
   *       from the master-key bypass.
   *
   * The SIBLING-LEAK CHECK is the critical anti-leak guarantee (KTD3): for an
   * only_me meeting, a denied non-participant teammate must ALSO be denied the
   * meeting's cards / syntheses / meeting_events rows — not just `meetings` —
   * while the owner and super_admin still see them.
   */
  describe('privacy-aware RLS access matrix (U3)', () => {
    let admin: SupabaseClient;
    let owner: TestUser; // plain member, launcher/owner of the meeting
    let participant: TestUser; // teammate who attended the meeting
    let nonParticipant: TestUser; // org member who did NOT attend
    let adminMgr: TestUser; // manager (admin tier), not a participant
    let superAdmin: TestUser; // super_admin, not a participant
    let outsider: TestUser; // member of a DIFFERENT org
    let orgId: string;
    let otherOrgId: string;
    let meetingId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      owner = await createTestUser(admin, 'rls-u3-owner@example.com');
      participant = await createTestUser(admin, 'rls-u3-part@example.com');
      nonParticipant = await createTestUser(admin, 'rls-u3-nonpart@example.com');
      adminMgr = await createTestUser(admin, 'rls-u3-mgr@example.com');
      superAdmin = await createTestUser(admin, 'rls-u3-sa@example.com');
      outsider = await createTestUser(admin, 'rls-u3-out@example.com');

      // Primary org: super_admin seeds it (so the last-super_admin invariant
      // holds), then add the rest.
      orgId = await createOrgWithMember(admin, 'U3 Access Org', superAdmin.id, 'super_admin');
      await addMember(admin, orgId, owner.id, 'member', false);
      await addMember(admin, orgId, participant.id, 'member', false);
      await addMember(admin, orgId, nonParticipant.id, 'member', false);
      await addMember(admin, orgId, adminMgr.id, 'manager', true);
      await admin.from('org_privacy_config').insert({ org_id: orgId });

      // A second org for the outsider (different org => never an org member here).
      otherOrgId = await createOrgWithMember(admin, 'U3 Other Org', outsider.id, 'super_admin');
      await admin.from('org_privacy_config').insert({ org_id: otherOrgId });

      // Owner is a plain member; the meeting's user_id = owner.id.
      const { data: m, error: mErr } = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: owner.id, status: 'completed' })
        .select('meeting_id')
        .single();
      if (mErr !== null || m === null) {
        throw new Error(`Failed to create U3 meeting: ${mErr?.message ?? 'no row'}`);
      }
      meetingId = m.meeting_id as string;

      // Only `participant` attended.
      await admin
        .from('meeting_participants')
        .insert({ meeting_id: meetingId, user_id: participant.id });

      // Seed one row in each sibling capture table for the sibling-leak check.
      const cardSeed = await admin.from('cards').insert({
        card_id: `u3-card-${meetingId}`,
        meeting_id: meetingId,
        org_id: orgId,
        source: 'test',
        type: 'test',
        triggered_by: 'test',
        trace_id: 'u3-trace',
      });
      if (cardSeed.error !== null) throw new Error(`card seed: ${cardSeed.error.message}`);
      const synSeed = await admin.from('syntheses').insert({
        synthesis_id: `u3-syn-${meetingId}`,
        meeting_id: meetingId,
        org_id: orgId,
        status: 'done',
        trace_id: 'u3-trace',
      });
      if (synSeed.error !== null) throw new Error(`synthesis seed: ${synSeed.error.message}`);
      const evSeed = await admin.from('meeting_events').insert({
        meeting_id: meetingId,
        org_id: orgId,
        type: 'test',
      });
      if (evSeed.error !== null) throw new Error(`event seed: ${evSeed.error.message}`);
    });

    afterAll(async () => {
      await admin.from('cards').delete().eq('meeting_id', meetingId);
      await admin.from('syntheses').delete().eq('meeting_id', meetingId);
      await admin.from('meeting_events').delete().eq('meeting_id', meetingId);
      await admin.from('meeting_participants').delete().eq('meeting_id', meetingId);
      await admin.from('meetings').delete().eq('org_id', orgId);
      await admin.from('org_privacy_config').delete().eq('org_id', orgId);
      await admin.from('org_privacy_config').delete().eq('org_id', otherOrgId);
      await admin.auth.admin.deleteUser(owner.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(participant.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(nonParticipant.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(adminMgr.id).catch(() => undefined);
      // super_admin org rows are blocked from deletion by the last-super_admin
      // trigger (documented residue; psql pre-clean clears the users + orphans).
      await admin.auth.admin.deleteUser(superAdmin.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(outsider.id).catch(() => undefined);
    });

    /** Can this persona SELECT the meetings row? (RLS via their anon client.) */
    async function canSeeMeeting(u: TestUser): Promise<boolean> {
      const { data } = await u.client
        .from('meetings')
        .select('meeting_id')
        .eq('meeting_id', meetingId);
      return (data ?? []).length > 0;
    }

    /** Set the meeting's privacy via service-role (bypasses RLS + floor=only_me). */
    async function setPrivacy(level: string): Promise<void> {
      const { error } = await admin
        .from('meetings')
        .update({ privacy_level: level })
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId);
      if (error !== null) throw new Error(`setPrivacy(${level}) failed: ${error.message}`);
    }

    it('only_me: owner+super_admin YES; participant/nonparticipant/admin/outsider NO [AE1,AE5]', async () => {
      await setPrivacy('only_me');
      expect(await canSeeMeeting(owner)).toBe(true);
      expect(await canSeeMeeting(superAdmin)).toBe(true); // master key
      expect(await canSeeMeeting(participant)).toBe(false);
      expect(await canSeeMeeting(nonParticipant)).toBe(false);
      expect(await canSeeMeeting(adminMgr)).toBe(false); // managers NOT exempt
      expect(await canSeeMeeting(outsider)).toBe(false);
    });

    it('only_participants: owner+participant+super_admin YES; nonparticipant/admin/outsider NO [AE6]', async () => {
      await setPrivacy('only_participants');
      expect(await canSeeMeeting(owner)).toBe(true);
      expect(await canSeeMeeting(participant)).toBe(true);
      expect(await canSeeMeeting(superAdmin)).toBe(true);
      expect(await canSeeMeeting(nonParticipant)).toBe(false);
      expect(await canSeeMeeting(adminMgr)).toBe(false);
      expect(await canSeeMeeting(outsider)).toBe(false);
    });

    it('only_teammates: every org member YES; outsider NO [AE2]', async () => {
      await setPrivacy('only_teammates');
      expect(await canSeeMeeting(owner)).toBe(true);
      expect(await canSeeMeeting(participant)).toBe(true);
      expect(await canSeeMeeting(nonParticipant)).toBe(true);
      expect(await canSeeMeeting(adminMgr)).toBe(true);
      expect(await canSeeMeeting(superAdmin)).toBe(true);
      expect(await canSeeMeeting(outsider)).toBe(false);
    });

    it('SIBLING-LEAK: only_me denied teammate sees 0 cards/syntheses/events; owner+SA see >0', async () => {
      await setPrivacy('only_me');

      // Denied non-participant teammate: zero rows across EVERY sibling table.
      const np = nonParticipant.client;
      expect(((await np.from('cards').select('card_id').eq('meeting_id', meetingId)).data ?? []).length).toBe(0);
      expect(((await np.from('syntheses').select('synthesis_id').eq('meeting_id', meetingId)).data ?? []).length).toBe(0);
      expect(((await np.from('meeting_events').select('event_id').eq('meeting_id', meetingId)).data ?? []).length).toBe(0);

      // Owner sees its own only_me meeting's payload.
      const ow = owner.client;
      expect(((await ow.from('cards').select('card_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await ow.from('syntheses').select('synthesis_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await ow.from('meeting_events').select('event_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
    });

    it('super_admin master key sees rows across ALL capture tables for an only_me meeting [R3]', async () => {
      await setPrivacy('only_me');
      const sa = superAdmin.client;
      expect(((await sa.from('meetings').select('meeting_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await sa.from('cards').select('card_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await sa.from('syntheses').select('synthesis_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await sa.from('meeting_events').select('event_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
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
