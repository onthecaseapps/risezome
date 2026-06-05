// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom. jsdom's BroadcastChannel shim
// throws ERR_INVALID_ARG_TYPE on the supabase-js realtime client, crashing the
// worker (see roles.test.ts / rls-test-harness notes).
/**
 * U3 (plan 2026-06-03-003): column-level write scoping for the genuine
 * authenticated client write paths, and RLS default-deny for the dropped
 * knowledge_gap_sections client write policies.
 *
 * Asserts the security property directly: an authenticated user can write ONLY
 * the intended column (bot_optin / read_at) on their own row, and a direct
 * PostgREST write of any other column — or any direct gap-section write — is
 * rejected. Same harness as config-writes.test.ts; auto-skips without a local
 * Supabase stack unless RISEZOME_RUN_RLS_TESTS=1.
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
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: SUPABASE_ANON_KEY } });
    return res.ok;
  } catch {
    return false;
  }
}

const stackReachable = await isStackReachable();

if (!stackReachable && !FORCE) {
  describe.skip('column write scoping RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('U3: column-scoped client writes', () => {
    let admin: SupabaseClient;
    let owner: TestUser;
    let orgId: string;
    let eventId: string;
    let notificationId: number;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      owner = await createTestUser(admin, 'rls-cws-owner@example.com');
      orgId = await createOrgWithMember(admin, 'CWS Org', owner.id, 'manager');

      const ev = await admin
        .from('calendar_events')
        .insert({
          org_id: orgId,
          user_id: owner.id,
          event_id: 'cws-evt-1',
          title: 'Standup',
          start_at: new Date(Date.now() + 3600_000).toISOString(),
          end_at: new Date(Date.now() + 7200_000).toISOString(),
          conference_url: 'https://zoom.us/j/cws',
          platform: 'zoom',
          bot_optin: false,
        })
        .select('id')
        .single();
      if (ev.error) throw new Error(`seed calendar_event: ${ev.error.message}`);
      eventId = (ev.data as { id: string }).id;

      const note = await admin
        .from('notifications')
        .insert({ org_id: orgId, user_id: owner.id, type: 'gap_assigned' })
        .select('notification_id')
        .single();
      if (note.error) throw new Error(`seed notification: ${note.error.message}`);
      notificationId = (note.data as { notification_id: number }).notification_id;
    });

    afterAll(async () => {
      try {
        if (eventId) await admin.from('calendar_events').delete().eq('id', eventId);
        if (notificationId) await admin.from('notifications').delete().eq('notification_id', notificationId);
        await admin.auth.admin.deleteUser(owner.id);
      } catch {
        // best-effort teardown
      }
    });

    it('calendar_events: owner may flip bot_optin on their own event', async () => {
      const res = await owner.client
        .from('calendar_events')
        .update({ bot_optin: true })
        .eq('id', eventId)
        .eq('user_id', owner.id)
        .select('id');
      expect(res.error).toBeNull();
      expect(res.data ?? []).toHaveLength(1);
    });

    it('calendar_events: owner CANNOT rewrite conference_url on their own event (column grant)', async () => {
      const res = await owner.client
        .from('calendar_events')
        .update({ conference_url: 'https://evil.example/hijack' })
        .eq('id', eventId)
        .eq('user_id', owner.id);
      expect(res.error).not.toBeNull(); // 42501 insufficient_privilege
    });

    it('calendar_events: owner CANNOT move their event to another org', async () => {
      const res = await owner.client
        .from('calendar_events')
        .update({ org_id: '00000000-0000-0000-0000-0000000000ff' })
        .eq('id', eventId)
        .eq('user_id', owner.id);
      expect(res.error).not.toBeNull();
    });

    it('notifications: owner may mark their own notification read', async () => {
      const res = await owner.client
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('notification_id', notificationId)
        .select('notification_id');
      expect(res.error).toBeNull();
      expect(res.data ?? []).toHaveLength(1);
    });

    it('notifications: owner CANNOT rewrite a notification type/actor', async () => {
      const res = await owner.client
        .from('notifications')
        .update({ type: 'forged' })
        .eq('notification_id', notificationId);
      expect(res.error).not.toBeNull();
    });

    it('knowledge_gap_sections: a direct client INSERT is rejected (writes are service-role only)', async () => {
      // owner is a manager — before U3 the dropped "managers insert" policy would
      // have allowed this; now RLS default-deny blocks all direct client writes.
      const res = await owner.client
        .from('knowledge_gap_sections')
        .insert({ section_id: crypto.randomUUID(), org_id: orgId, name: 'Direct insert attempt' });
      expect(res.error).not.toBeNull();
      expect(res.error?.code).toBe('42501'); // RLS row-level security, not a schema error

      // service-role still writes fine (the real path).
      const sectionId = crypto.randomUUID();
      const viaService = await admin
        .from('knowledge_gap_sections')
        .insert({ section_id: sectionId, org_id: orgId, name: 'Service-role section' })
        .select('section_id')
        .single();
      expect(viaService.error).toBeNull();
      await admin.from('knowledge_gap_sections').delete().eq('section_id', sectionId);
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
  const { data: org, error } = await admin.from('orgs').insert({ name: orgName }).select('id').single();
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
