// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel
// shim throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client's
// MessageEvent, which would crash the worker and skip every test here.
/**
 * Attendees-only meeting access RLS tests (teams restructure U2).
 *
 * The per-meeting privacy ladder is GONE: `can_access_meeting` is now
 * `is_super_admin(org_id) OR owner OR is_meeting_participant(meeting_id)`. There
 * is a single, level-free access boundary, verified here against the local
 * stack:
 *
 *   persona               can SELECT the meeting?
 *   owner (launcher)       YES   (entitled regardless of attendance)
 *   participant            YES   (attended)
 *   nonparticipant member  NO    (in the org, did not attend)
 *   manager (admin tier)   NO    (admins are NOT exempt — only super_admin is)
 *   super_admin            YES   (master key)
 *   outsider (other org)   NO
 *
 * SIBLING-LEAK CHECK (the critical anti-leak guarantee): a denied
 * non-participant teammate must ALSO be denied the meeting's
 * cards / syntheses / meeting_events rows — not just `meetings`.
 *
 * Same harness shape as roles.test.ts: real local Supabase stack; auto-skips
 * when unreachable unless RISEZOME_RUN_RLS_TESTS=1.
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
  describe.skip('meeting-access RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('attendees-only meeting access (U2)', () => {
    let admin: SupabaseClient;
    let owner: TestUser; // plain member, launcher/owner of the meeting
    let participant: TestUser; // teammate who attended the meeting
    let nonParticipant: TestUser; // org member who did NOT attend
    let adminMgr: TestUser; // manager (admin tier), not a participant
    let superAdmin: TestUser; // super_admin, not a participant
    let outsider: TestUser; // member of a DIFFERENT org
    let orgId: string;
    let meetingId: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      owner = await createTestUser(admin, 'rls-u2-owner@example.com');
      participant = await createTestUser(admin, 'rls-u2-part@example.com');
      nonParticipant = await createTestUser(admin, 'rls-u2-nonpart@example.com');
      adminMgr = await createTestUser(admin, 'rls-u2-mgr@example.com');
      superAdmin = await createTestUser(admin, 'rls-u2-sa@example.com');
      outsider = await createTestUser(admin, 'rls-u2-out@example.com');

      // Primary org: super_admin seeds it (so the last-super_admin invariant
      // holds), then add the rest.
      orgId = await createOrgWithMember(admin, 'U2 Access Org', superAdmin.id, 'super_admin');
      await addMember(admin, orgId, owner.id, 'member', false);
      await addMember(admin, orgId, participant.id, 'member', false);
      await addMember(admin, orgId, nonParticipant.id, 'member', false);
      await addMember(admin, orgId, adminMgr.id, 'manager', true);

      // A second org for the outsider (different org => never an org member here).
      await createOrgWithMember(admin, 'U2 Other Org', outsider.id, 'super_admin');

      // Owner is a plain member; the meeting's user_id = owner.id.
      const { data: m, error: mErr } = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: owner.id, status: 'completed' })
        .select('meeting_id')
        .single();
      if (mErr !== null || m === null) {
        throw new Error(`Failed to create U2 meeting: ${mErr?.message ?? 'no row'}`);
      }
      meetingId = m.meeting_id as string;

      // Only `participant` attended.
      await admin
        .from('meeting_participants')
        .insert({ meeting_id: meetingId, user_id: participant.id });

      // Seed one row in each sibling capture table for the sibling-leak check.
      const cardSeed = await admin.from('cards').insert({
        card_id: `u2-card-${meetingId}`,
        meeting_id: meetingId,
        org_id: orgId,
        source: 'test',
        type: 'test',
        triggered_by: 'test',
        trace_id: 'u2-trace',
      });
      if (cardSeed.error !== null) throw new Error(`card seed: ${cardSeed.error.message}`);
      const synSeed = await admin.from('syntheses').insert({
        synthesis_id: `u2-syn-${meetingId}`,
        meeting_id: meetingId,
        org_id: orgId,
        status: 'done',
        trace_id: 'u2-trace',
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

    it('a participant can SELECT their meeting', async () => {
      expect(await canSeeMeeting(participant)).toBe(true);
    });

    it('the owner can SELECT their meeting (entitled regardless of attendance)', async () => {
      expect(await canSeeMeeting(owner)).toBe(true);
    });

    it('a non-participant org member CANNOT SELECT the meeting', async () => {
      expect(await canSeeMeeting(nonParticipant)).toBe(false);
    });

    it('a manager (admin tier) is NOT exempt — cannot SELECT a meeting they did not attend', async () => {
      expect(await canSeeMeeting(adminMgr)).toBe(false);
    });

    it('a super_admin CAN SELECT the meeting (master key)', async () => {
      expect(await canSeeMeeting(superAdmin)).toBe(true);
    });

    it('an outsider (different org) CANNOT SELECT the meeting', async () => {
      expect(await canSeeMeeting(outsider)).toBe(false);
    });

    it('SIBLING-LEAK: a denied non-participant sees 0 cards/syntheses/events; owner+SA see >0', async () => {
      // Denied non-participant teammate: zero rows across EVERY sibling table.
      const np = nonParticipant.client;
      expect(((await np.from('cards').select('card_id').eq('meeting_id', meetingId)).data ?? []).length).toBe(0);
      expect(((await np.from('syntheses').select('synthesis_id').eq('meeting_id', meetingId)).data ?? []).length).toBe(0);
      expect(((await np.from('meeting_events').select('event_id').eq('meeting_id', meetingId)).data ?? []).length).toBe(0);

      // Owner sees its own meeting's payload.
      const ow = owner.client;
      expect(((await ow.from('cards').select('card_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await ow.from('syntheses').select('synthesis_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
      expect(((await ow.from('meeting_events').select('event_id').eq('meeting_id', meetingId)).data ?? []).length).toBeGreaterThan(0);
    });

    it('super_admin master key sees rows across ALL capture tables [R3]', async () => {
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
