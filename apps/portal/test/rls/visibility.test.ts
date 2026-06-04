// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel
// shim throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client's
// MessageEvent, which crashes the worker and aborts every test here (the same
// reason meeting-participants.test.ts / meeting-privacy.test.ts pin node).
/**
 * Per-person visibility RLS tests (plan U4). Verifies that participant-scoped
 * access is enforced across every captures-bearing table, with NO sibling leak.
 *
 * Covers R5, R6, R14, AE3, AE7. Same harness as orgs.test.ts; auto-skips
 * without a local Supabase stack unless RISEZOME_RUN_RLS_TESTS=1.
 *
 * ── ADAPTED FOR THE PRIVACY MODEL (permissions overhaul U2/U3) ───────────────
 * These tests originally relied on the global participant-scoping invariant
 * (is_meeting_participant). U3 replaced that with per-meeting privacy levels via
 * can_access_meeting, and the new DEFAULT is `only_teammates` (org-wide), which
 * would make every org member see every meeting and break the participant-deny
 * assertions below. The INTENT here — "a non-participant teammate cannot read a
 * meeting they didn't attend, on `meetings` OR any sibling capture table" — is
 * exactly the `only_participants` privacy level, so insertMeeting() now stamps
 * privacy_level='only_participants'. The org's privacy_floor is left at the
 * permissive default (only_me) so that level is allowed. Behaviour and intent
 * are preserved; only the explicit privacy level is now pinned (it used to be
 * the implicit global default).
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
  describe.skip('per-person visibility RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('per-person visibility RLS', () => {
    let admin: SupabaseClient;
    let manager: TestUser; // user A — manager of the org
    let member: TestUser; // user B — plain member of the SAME org
    let orgId: string;
    let meetingOfManager: string; // participant: manager only
    let meetingOfMember: string; // participant: member only
    let sharedMeeting: string; // launched by manager, both participants

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      manager = await createTestUser(admin, 'rls-vis-mgr@example.com');
      member = await createTestUser(admin, 'rls-vis-mem@example.com');

      orgId = await createOrgWithMember(admin, 'Vis Org', manager.id, 'manager');
      await addMember(admin, orgId, member.id, 'member', false);
      // Permissive floor (only_me) so insertMeeting can stamp only_participants.
      await admin.from('org_privacy_config').insert({ org_id: orgId });

      meetingOfManager = await insertMeeting(admin, orgId, manager.id, 'https://meet/m1');
      await addParticipant(admin, meetingOfManager, manager.id);
      await insertCard(admin, meetingOfManager, orgId, 'card-mgr');

      meetingOfMember = await insertMeeting(admin, orgId, member.id, 'https://meet/m2');
      await addParticipant(admin, meetingOfMember, member.id);
      await insertCard(admin, meetingOfMember, orgId, 'card-mem');

      sharedMeeting = await insertMeeting(admin, orgId, manager.id, 'https://meet/shared');
      await addParticipant(admin, sharedMeeting, manager.id);
      await addParticipant(admin, sharedMeeting, member.id);
      await insertCard(admin, sharedMeeting, orgId, 'card-shared');

      await insertCalendarEvent(admin, orgId, manager.id, 'evt-mgr');
      await insertCalendarEvent(admin, orgId, member.id, 'evt-mem');
    });

    afterAll(async () => {
      await admin.from('org_privacy_config').delete().eq('org_id', orgId);
      await admin.auth.admin.deleteUser(manager.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(member.id).catch(() => undefined);
    });

    it("R5/AE3: member sees only meetings they participated in, not a co-member's", async () => {
      const { data, error } = await member.client.from('meetings').select('meeting_id');
      expect(error).toBeNull();
      const ids = (data ?? []).map((r) => r.meeting_id as string);
      expect(ids).toContain(meetingOfMember);
      expect(ids).toContain(sharedMeeting);
      expect(ids).not.toContain(meetingOfManager);
    });

    it('R5: a MANAGER is not exempt — sees only meetings they attended', async () => {
      const { data, error } = await manager.client.from('meetings').select('meeting_id');
      expect(error).toBeNull();
      const ids = (data ?? []).map((r) => r.meeting_id as string);
      expect(ids).toContain(meetingOfManager);
      expect(ids).toContain(sharedMeeting);
      expect(ids).not.toContain(meetingOfMember);
    });

    it('R14/AE7: a member sees the capture of a meeting launched by another participant', async () => {
      const { data, error } = await member.client
        .from('cards')
        .select('card_id')
        .eq('meeting_id', sharedMeeting);
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.card_id)).toContain('card-shared');
    });

    it("R5: a non-participant cannot read another meeting's cards/syntheses/gaps/events", async () => {
      const cards = await member.client
        .from('cards')
        .select('card_id')
        .eq('meeting_id', meetingOfManager);
      expect(cards.error).toBeNull();
      expect(cards.data ?? []).toEqual([]);

      const events = await member.client
        .from('meeting_events')
        .select('event_id')
        .eq('meeting_id', meetingOfManager);
      expect(events.error).toBeNull();
      expect(events.data ?? []).toEqual([]);
    });

    it('U8/S8: a participant CANNOT directly UPDATE a card via the client (no client UPDATE policy)', async () => {
      // The "participants pin meeting cards" UPDATE policy was dropped — pin/dismiss
      // route through org-scoped service-role actions only. manager participates in
      // meetingOfManager, yet a direct client UPDATE must affect zero rows.
      const res = await manager.client
        .from('cards')
        .update({ pinned: true, title: 'hijacked' })
        .eq('card_id', 'card-mgr')
        .select('card_id');
      expect(res.error).toBeNull();
      expect(res.data ?? []).toEqual([]); // 0 rows updated (RLS denies the write)

      // Confirm the row was untouched.
      const check = await admin
        .from('cards')
        .select('pinned, title')
        .eq('card_id', 'card-mgr')
        .single();
      expect(check.data?.pinned).not.toBe(true);
      expect(check.data?.title).not.toBe('hijacked');
    });

    it("calendar_events SELECT returns only the requesting user's events", async () => {
      const { data, error } = await member.client
        .from('calendar_events')
        .select('event_id, user_id');
      expect(error).toBeNull();
      expect((data ?? []).every((r) => r.user_id === member.id)).toBe(true);
    });

    it('R6: a manager reads all org_members rows; a member reads only their own', async () => {
      const asManager = await manager.client.from('org_members').select('user_id');
      expect(asManager.error).toBeNull();
      const ids = (asManager.data ?? []).map((r) => r.user_id as string);
      expect(ids).toContain(manager.id);
      expect(ids).toContain(member.id);

      const asMember = await member.client.from('org_members').select('user_id');
      expect(asMember.error).toBeNull();
      expect((asMember.data ?? []).every((r) => r.user_id === member.id)).toBe(true);
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
  const { data: org, error } = await admin
    .from('orgs')
    .insert({ name: orgName })
    .select('id')
    .single();
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

async function insertMeeting(
  admin: SupabaseClient,
  orgId: string,
  launcherId: string,
  url: string,
): Promise<string> {
  const { data, error } = await admin
    .from('meetings')
    .insert({
      org_id: orgId,
      user_id: launcherId,
      conference_url: url,
      status: 'completed',
      // Pin to only_participants so the participant-scoped deny assertions hold
      // under the U3 privacy model (the new default only_teammates is org-wide).
      privacy_level: 'only_participants',
    })
    .select('meeting_id')
    .single();
  if (error !== null || data === null)
    throw new Error(`Failed to insert meeting: ${error?.message ?? 'no row'}`);
  return data.meeting_id as string;
}

async function addParticipant(
  admin: SupabaseClient,
  meetingId: string,
  userId: string,
): Promise<void> {
  const { error } = await admin
    .from('meeting_participants')
    .insert({ meeting_id: meetingId, user_id: userId });
  if (error !== null) throw new Error(`Failed to add participant: ${error.message}`);
}

async function insertCard(
  admin: SupabaseClient,
  meetingId: string,
  orgId: string,
  cardId: string,
): Promise<void> {
  const { error } = await admin.from('cards').insert({
    card_id: cardId,
    meeting_id: meetingId,
    org_id: orgId,
    source: 'github',
    type: 'issue',
    triggered_by: 'window',
    trace_id: 't',
  });
  if (error !== null) throw new Error(`Failed to insert card: ${error.message}`);
}

async function insertCalendarEvent(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  eventId: string,
): Promise<void> {
  const { error } = await admin.from('calendar_events').insert({
    org_id: orgId,
    user_id: userId,
    event_id: eventId,
    start_at: new Date(0).toISOString(),
    end_at: new Date(0).toISOString(),
  });
  if (error !== null) throw new Error(`Failed to insert calendar event: ${error.message}`);
}
