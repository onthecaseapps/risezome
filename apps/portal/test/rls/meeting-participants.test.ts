/**
 * Dedup + participant-association tests for one-bot-per-meeting (plan U3).
 *
 * Covers:
 *   - R12: at most one LIVE meeting per (org_id, conference_url)
 *   - a 'completed' meeting does NOT block a new live one for the same URL
 *     (recurring/personal-room links — KTD8 over-merge guard)
 *   - is_meeting_participant() reflects the association
 *   - meeting_participants RLS: a user reads only their own participant rows
 *
 * Same harness shape as orgs.test.ts; auto-skips without a local Supabase
 * stack unless RISEZOME_RUN_RLS_TESTS=1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';
const TOKEN_KEY = 'rls-recap-test-key-' + 'k'.repeat(40); // U9 recap encryption

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
  describe.skip('meeting dedup + participants RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('meeting dedup + participant association', () => {
    let admin: SupabaseClient;
    let launcher: TestUser;
    let coAttendee: TestUser;
    let outsider: TestUser;
    let orgId: string;
    const url = 'https://zoom.us/j/test-dedup-room';

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      launcher = await createTestUser(admin, 'rls-mp-launcher@example.com');
      coAttendee = await createTestUser(admin, 'rls-mp-co@example.com');
      outsider = await createTestUser(admin, 'rls-mp-out@example.com');

      orgId = await createOrgWithMember(admin, 'MP Org', launcher.id, 'manager');
      await addMember(admin, orgId, coAttendee.id, 'member', true);
    });

    afterAll(async () => {
      await admin.auth.admin.deleteUser(launcher.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(coAttendee.id).catch(() => undefined);
      await admin.auth.admin.deleteUser(outsider.id).catch(() => undefined);
    });

    it('U9/S9: the meeting recap is stored encrypted — no plaintext column, decrypt round-trips', async () => {
      const enc = await admin.rpc('encrypt_refresh_token', {
        plaintext: 'Confidential recap: we are acquiring Acme for $40M.',
        key: TOKEN_KEY,
      });
      const m = await admin
        .from('meetings')
        .insert({
          org_id: orgId,
          user_id: launcher.id,
          conference_url: 'https://zoom.us/j/recap-enc',
          status: 'completed',
          recap_text_enc: enc.data as unknown as string,
          recap_status: 'done',
        })
        .select('meeting_id')
        .single();
      expect(m.error).toBeNull();

      // Plaintext column is gone.
      const plaintextSel = await admin.from('meetings').select('recap_text');
      expect(plaintextSel.error).not.toBeNull();

      // Ciphertext decrypts back to the original.
      const { data: row } = await admin
        .from('meetings')
        .select('recap_text_enc, recap_key_version')
        .eq('meeting_id', m.data!.meeting_id as string)
        .single();
      expect(row?.recap_key_version).toBe(0);
      const dec = await admin.rpc('decrypt_refresh_token', {
        ciphertext: (row as { recap_text_enc: string }).recap_text_enc,
        key: TOKEN_KEY,
      });
      expect(dec.data).toBe('Confidential recap: we are acquiring Acme for $40M.');

      if (m.data) await admin.from('meetings').delete().eq('meeting_id', m.data.meeting_id);
    });

    it('F1: the synthesized answer is stored encrypted — no plaintext column, decrypt round-trips', async () => {
      const meeting = await admin
        .from('meetings')
        .insert({
          org_id: orgId,
          user_id: launcher.id,
          conference_url: 'https://zoom.us/j/synth-enc',
          status: 'completed',
        })
        .select('meeting_id')
        .single();
      expect(meeting.error).toBeNull();
      const meetingId = meeting.data!.meeting_id as string;

      const enc = await admin.rpc('encrypt_refresh_token', {
        plaintext: 'The repo uses Kafka for the event bus [1].',
        key: TOKEN_KEY,
      });
      const s = await admin
        .from('syntheses')
        .insert({
          synthesis_id: `synth_${Date.now()}`,
          meeting_id: meetingId,
          org_id: orgId,
          source_card_ids: [],
          accumulated_text_enc: enc.data as unknown as string,
          status: 'done',
          citations: [],
          trace_id: 't',
        })
        .select('synthesis_id')
        .single();
      expect(s.error).toBeNull();

      // Plaintext column is gone.
      const plaintextSel = await admin.from('syntheses').select('accumulated_text');
      expect(plaintextSel.error).not.toBeNull();

      const { data: row } = await admin
        .from('syntheses')
        .select('accumulated_text_enc, synth_key_version')
        .eq('synthesis_id', s.data!.synthesis_id as string)
        .single();
      expect(row?.synth_key_version).toBe(0);
      const dec = await admin.rpc('decrypt_refresh_token', {
        ciphertext: (row as { accumulated_text_enc: string }).accumulated_text_enc,
        key: TOKEN_KEY,
      });
      expect(dec.data).toBe('The repo uses Kafka for the event bus [1].');

      await admin.from('meetings').delete().eq('meeting_id', meetingId);
    });

    it('blocks a second LIVE meeting for the same (org, conference_url)', async () => {
      const first = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: launcher.id, conference_url: url, status: 'recording' })
        .select('meeting_id')
        .single();
      expect(first.error).toBeNull();

      const second = await admin.from('meetings').insert({
        org_id: orgId,
        user_id: coAttendee.id,
        conference_url: url,
        status: 'launching',
      });
      expect(second.error).not.toBeNull(); // unique-index violation

      // Cleanup
      if (first.data) {
        await admin.from('meetings').delete().eq('meeting_id', first.data.meeting_id);
      }
    });

    it('a completed meeting does not block a new live one for the same URL', async () => {
      const done = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: launcher.id, conference_url: url, status: 'completed' })
        .select('meeting_id')
        .single();
      expect(done.error).toBeNull();

      const fresh = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: launcher.id, conference_url: url, status: 'launching' })
        .select('meeting_id')
        .single();
      expect(fresh.error).toBeNull();

      if (done.data) await admin.from('meetings').delete().eq('meeting_id', done.data.meeting_id);
      if (fresh.data) await admin.from('meetings').delete().eq('meeting_id', fresh.data.meeting_id);
    });

    it('is_meeting_participant() and participant-row RLS reflect the association', async () => {
      const meeting = await admin
        .from('meetings')
        .insert({ org_id: orgId, user_id: launcher.id, conference_url: url, status: 'recording' })
        .select('meeting_id')
        .single();
      expect(meeting.error).toBeNull();
      const meetingId = meeting.data!.meeting_id as string;

      await admin.from('meeting_participants').insert([
        { meeting_id: meetingId, user_id: launcher.id },
        { meeting_id: meetingId, user_id: coAttendee.id },
      ]);

      const launcherSees = await launcher.client.rpc('is_meeting_participant', {
        p_meeting_id: meetingId,
      });
      expect(launcherSees.data).toBe(true);
      const outsiderSees = await outsider.client.rpc('is_meeting_participant', {
        p_meeting_id: meetingId,
      });
      expect(outsiderSees.data).toBe(false);

      // Participant-row RLS: launcher reads their own row, not the outsider's view.
      const own = await launcher.client
        .from('meeting_participants')
        .select('user_id')
        .eq('meeting_id', meetingId);
      expect(own.error).toBeNull();
      expect((own.data ?? []).every((r) => r.user_id === launcher.id)).toBe(true);

      const none = await outsider.client
        .from('meeting_participants')
        .select('user_id')
        .eq('meeting_id', meetingId);
      expect(none.error).toBeNull();
      expect(none.data ?? []).toEqual([]);

      await admin.from('meetings').delete().eq('meeting_id', meetingId);
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
