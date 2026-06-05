// @vitest-environment node
// Pure DB/RLS test — runs in real Node, not jsdom (see roles.test.ts).
/**
 * Gap visibility + metadata-only assignment (plan U5; KTD6, R7/R8/AE3/AE4).
 *
 * Covers:
 *   - an attendee (participant-seeded gap_viewer) sees the gap + its verbatim
 *   - a NON-attendee ASSIGNEE sees NEITHER the gap row NOR the verbatim occurrence
 *     (assignment no longer grants can_view_gap), but list_assigned_questions
 *     returns the question + asker + metrics ONLY (AE3)
 *   - a non-attendee, non-assignee member sees nothing (AE4)
 *   - the super-admin master key sees the gap; a plain manager (admin) who didn't
 *     attend does NOT (gaps are attendees ∪ master key, R9)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const FORCE = process.env['RISEZOME_RUN_RLS_TESTS'] === '1';

interface TestUser {
  readonly id: string;
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
  describe.skip('gap assignment (stack not reachable)', () => {
    it('skipped', () => {});
  });
} else {
  describe('gap visibility + metadata-only assignment', () => {
    let admin: SupabaseClient;
    let superAdmin: TestUser;
    let manager: TestUser;   // admin tier, did NOT attend
    let attendee: TestUser;  // participant-seeded gap_viewer
    let assignee: TestUser;  // non-attendee, assigned the question
    let other: TestUser;     // non-attendee, non-assignee member
    let orgId: string;
    const gapId = 'gap-u5-test';

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      superAdmin = await mkUser(admin, 'rls-ga-sa@example.com');
      manager = await mkUser(admin, 'rls-ga-mgr@example.com');
      attendee = await mkUser(admin, 'rls-ga-att@example.com');
      assignee = await mkUser(admin, 'rls-ga-asg@example.com');
      other = await mkUser(admin, 'rls-ga-oth@example.com');

      orgId = (await admin.from('orgs').insert({ name: 'GA Org' }).select('id').single()).data!.id as string;
      await admin.from('org_members').insert([
        { org_id: orgId, user_id: superAdmin.id, role: 'super_admin' },
        { org_id: orgId, user_id: manager.id, role: 'manager' },
        { org_id: orgId, user_id: attendee.id, role: 'member' },
        { org_id: orgId, user_id: assignee.id, role: 'member' },
        { org_id: orgId, user_id: other.id, role: 'member' },
      ]);

      // A gap with one verbatim occurrence; attendee is a participant-seeded viewer;
      // assignee is set as assignee_id but NOT added to gap_viewers (metadata-only).
      await admin.from('knowledge_gaps').insert({
        gap_id: gapId,
        org_id: orgId,
        title: 'How does the billing retry work?',
        status: 'open',
        frequency: 3,
        assignee_id: assignee.id,
        shared_with_org: false,
        last_asked_at: new Date().toISOString(),
      });
      await admin.from('gap_occurrences').insert({
        gap_id: gapId,
        org_id: orgId,
        meeting_id: (
          await admin.from('meetings').insert({ org_id: orgId, user_id: attendee.id, status: 'completed' }).select('meeting_id').single()
        ).data!.meeting_id,
        verbatim_question: 'SECRET VERBATIM: how does billing retry work exactly?',
        asker_name: 'Dana',
        reason: 'no_hits',
      });
      await admin.from('gap_viewers').insert({ gap_id: gapId, org_id: orgId, user_id: attendee.id });
    });

    afterAll(async () => {
      await admin.from('orgs').delete().eq('id', orgId);
      for (const u of [superAdmin, manager, attendee, assignee, other]) {
        await admin.auth.admin.deleteUser(u.id).catch(() => undefined);
      }
    });

    it('an attendee (gap_viewer) sees the gap and its verbatim occurrence', async () => {
      const g = await attendee.client.from('knowledge_gaps').select('gap_id').eq('gap_id', gapId);
      expect((g.data ?? []).length).toBe(1);
      const o = await attendee.client.from('gap_occurrences').select('verbatim_question').eq('gap_id', gapId);
      expect((o.data ?? []).length).toBe(1);
    });

    it('a non-attendee ASSIGNEE sees NO gap row and NO verbatim (assignment is metadata-only)', async () => {
      const g = await assignee.client.from('knowledge_gaps').select('gap_id').eq('gap_id', gapId);
      expect((g.data ?? []).length).toBe(0);
      const o = await assignee.client.from('gap_occurrences').select('verbatim_question').eq('gap_id', gapId);
      expect((o.data ?? []).length).toBe(0);
    });

    it('the assignee gets the question + asker + metrics via list_assigned_questions (AE3)', async () => {
      const { data, error } = await assignee.client.rpc('list_assigned_questions');
      expect(error).toBeNull();
      const rows = (data ?? []) as Array<{ gap_id: string; title: string; asker_name: string; frequency: number }>;
      const row = rows.find((r) => r.gap_id === gapId);
      expect(row).toBeDefined();
      expect(row?.title).toBe('How does the billing retry work?');
      expect(row?.asker_name).toBe('Dana');
      expect(row?.frequency).toBe(3);
      // Crucially, the projection carries NO verbatim field.
      expect(JSON.stringify(row)).not.toContain('SECRET VERBATIM');
    });

    it('a non-attendee, non-assignee member sees nothing (AE4)', async () => {
      const g = await other.client.from('knowledge_gaps').select('gap_id').eq('gap_id', gapId);
      expect((g.data ?? []).length).toBe(0);
      const assigned = await other.client.rpc('list_assigned_questions');
      expect((assigned.data ?? []).length).toBe(0);
    });

    it('super-admin master key sees the gap; a non-attendee manager does NOT (R9)', async () => {
      const sa = await superAdmin.client.from('knowledge_gaps').select('gap_id').eq('gap_id', gapId);
      expect((sa.data ?? []).length).toBe(1);
      const mgr = await manager.client.from('knowledge_gaps').select('gap_id').eq('gap_id', gapId);
      expect((mgr.data ?? []).length).toBe(0);
    });
  });
}

async function mkUser(admin: SupabaseClient, email: string): Promise<TestUser> {
  const { data: existing } = await admin.auth.admin.listUsers();
  const prior = existing?.users.find((u) => u.email === email);
  if (prior !== undefined) await admin.auth.admin.deleteUser(prior.id).catch(() => undefined);
  const password = `RlsTest_${Math.random().toString(36).slice(2)}!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error !== null || data.user === null) throw new Error(`mkUser ${email}: ${error?.message}`);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr !== null) throw new Error(`signin ${email}: ${signInErr.message}`);
  return { id: data.user.id, client };
}
