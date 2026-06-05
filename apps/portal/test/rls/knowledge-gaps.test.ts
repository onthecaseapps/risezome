// @vitest-environment node
/**
 * RLS denial tests for Knowledge Gaps (plan U2).
 *
 * Covers the KTD1 viewer-ACL visibility model and KTD/R22 curation permissions:
 *   - a non-viewer member cannot SELECT a gap; a viewer / assignee / shared /
 *     manager can
 *   - the assignee can UPDATE status; a non-assignee non-manager cannot
 *   - managers curate sections; members cannot
 *   - occurrences are visible iff the parent gap is
 *   - cross-org isolation
 *   - notifications are private to the recipient
 *
 * Same harness as roles.test.ts: real local Supabase stack via `supabase
 * start`; auto-skips when unreachable unless RISEZOME_RUN_RLS_TESTS=1.
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

let gapSeq = 0;
function freshGapId(): string {
  gapSeq += 1;
  return `gap_test_${String(gapSeq)}_${Math.random().toString(36).slice(2)}`;
}

if (!stackReachable && !FORCE) {
  describe.skip('knowledge-gaps RLS (Supabase stack not reachable)', () => {
    it('skipped', () => {
      // Set RISEZOME_RUN_RLS_TESTS=1 to require these in CI with Docker.
    });
  });
} else {
  describe('knowledge-gaps RLS', () => {
    let admin: SupabaseClient;
    let manager: TestUser; // manager of org A
    let participant: TestUser; // member of org A, viewer of the seeded gap
    let nonParticipant: TestUser; // member of org A, NOT a viewer
    let outsider: TestUser; // member of org B
    let orgA: string;
    let meetingA: string;

    beforeAll(async () => {
      admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      manager = await createTestUser(admin, 'rls-gaps-mgr@example.com');
      participant = await createTestUser(admin, 'rls-gaps-part@example.com');
      nonParticipant = await createTestUser(admin, 'rls-gaps-non@example.com');
      outsider = await createTestUser(admin, 'rls-gaps-out@example.com');

      orgA = await createOrgWithMember(admin, 'Gaps Org A', manager.id, 'manager');
      await addMember(admin, orgA, participant.id, 'member');
      await addMember(admin, orgA, nonParticipant.id, 'member');
      // Outsider belongs to a different org entirely (cross-org isolation).
      await createOrgWithMember(admin, 'Gaps Org B', outsider.id, 'manager');

      const { data: mtg, error: mtgErr } = await admin
        .from('meetings')
        .insert({ org_id: orgA, user_id: manager.id })
        .select('meeting_id')
        .single();
      if (mtgErr !== null || mtg === null) throw new Error(`meeting: ${mtgErr?.message}`);
      meetingA = mtg.meeting_id as string;
    });

    afterAll(async () => {
      for (const u of [manager, participant, nonParticipant, outsider]) {
        await admin.auth.admin.deleteUser(u.id).catch(() => undefined);
      }
    });

    async function seedGap(
      opts: { shared?: boolean; assignee?: string | null; viewers?: string[] } = {},
    ): Promise<string> {
      const gapId = freshGapId();
      const { error } = await admin.from('knowledge_gaps').insert({
        gap_id: gapId,
        org_id: orgA,
        title: 'What is the OAuth2 migration status?',
        status: 'open',
        shared_with_org: opts.shared ?? false,
        assignee_id: opts.assignee ?? null,
        frequency: 1,
      });
      if (error !== null) throw new Error(`seed gap: ${error.message}`);
      for (const uid of opts.viewers ?? []) {
        const { error: vErr } = await admin
          .from('gap_viewers')
          .insert({ gap_id: gapId, user_id: uid, org_id: orgA });
        if (vErr !== null) throw new Error(`seed viewer: ${vErr.message}`);
      }
      return gapId;
    }

    async function canSelectGap(user: TestUser, gapId: string): Promise<boolean> {
      const { data } = await user.client
        .from('knowledge_gaps')
        .select('gap_id')
        .eq('gap_id', gapId);
      return (data ?? []).length === 1;
    }

    it('a viewer can SELECT the gap; a non-viewer member cannot', async () => {
      const gapId = await seedGap({ viewers: [participant.id] });
      expect(await canSelectGap(participant, gapId)).toBe(true);
      expect(await canSelectGap(nonParticipant, gapId)).toBe(false);
    });

    it('adding a member to gap_viewers grants SELECT', async () => {
      const gapId = await seedGap({ viewers: [participant.id] });
      expect(await canSelectGap(nonParticipant, gapId)).toBe(false);
      await admin.from('gap_viewers').insert({ gap_id: gapId, user_id: nonParticipant.id, org_id: orgA });
      expect(await canSelectGap(nonParticipant, gapId)).toBe(true);
    });

    it('shared_with_org makes a gap visible to any org member', async () => {
      const gapId = await seedGap({ shared: true }); // no explicit viewers
      expect(await canSelectGap(nonParticipant, gapId)).toBe(true);
    });

    it('an assignee does NOT gain gap visibility (metadata-only, U5) and cannot directly PATCH', async () => {
      const gapId = await seedGap({ assignee: nonParticipant.id });
      // Teams restructure (KTD6): assignment no longer grants can_view_gap. A
      // non-attendee assignee sees the question/asker/metrics ONLY via
      // list_assigned_questions, never the gap row or its verbatim occurrences.
      expect(await canSelectGap(nonParticipant, gapId)).toBe(false);

      // And a direct PATCH must be denied (no client UPDATE policy) — otherwise an
      // assignee could escalate a private gap org-wide by PATCHing shared_with_org.
      await nonParticipant.client
        .from('knowledge_gaps')
        .update({ status: 'resolved', shared_with_org: true })
        .eq('gap_id', gapId);
      const { data: after } = await admin
        .from('knowledge_gaps')
        .select('status, shared_with_org')
        .eq('gap_id', gapId)
        .single();
      expect(after?.status).toBe('open'); // unchanged — RLS denied the write
      expect(after?.shared_with_org).toBe(false);

      // A plain participant likewise cannot directly update.
      await participant.client
        .from('knowledge_gaps')
        .update({ status: 'dismissed' })
        .eq('gap_id', gapId);
      const { data: still } = await admin
        .from('knowledge_gaps')
        .select('status')
        .eq('gap_id', gapId)
        .single();
      expect(still?.status).toBe('open');
    });

    it('a non-attendee manager does NOT see an unshared gap (attendees-only, U5)', async () => {
      // Teams restructure: gaps are attendees ∪ super-admin master key. A plain
      // Admin (manager) who didn't attend a contributing meeting has no blanket
      // gap access (the master-key positive is covered in gap-assignment.test.ts).
      const gapId = await seedGap(); // no viewers, not shared, unassigned
      expect(await canSelectGap(manager, gapId)).toBe(false);
      expect(await canSelectGap(nonParticipant, gapId)).toBe(false);
    });

    it('section writes are service-role only; no client (member or manager) can write directly', async () => {
      // knowledge_gap_sections client write policies were dropped (plan 003,
      // 20260607080000): curation now flows through service-role server actions,
      // so NO client write succeeds — including a manager's direct PostgREST write.
      const sectionId = `sec_test_${Math.random().toString(36).slice(2)}`;
      const seed = await admin
        .from('knowledge_gap_sections')
        .insert({ section_id: sectionId, org_id: orgA, name: 'Auth & Identity' });
      expect(seed.error).toBeNull(); // service-role (the real curation path) works

      const mgrInsert = await manager.client
        .from('knowledge_gap_sections')
        .insert({ section_id: `sec_mgr_${Math.random().toString(36).slice(2)}`, org_id: orgA, name: 'Direct' });
      expect(mgrInsert.error).not.toBeNull(); // 42501 — no client write policy

      const memInsert = await participant.client
        .from('knowledge_gap_sections')
        .insert({ section_id: `sec_bad_${Math.random().toString(36).slice(2)}`, org_id: orgA, name: 'Nope' });
      expect(memInsert.error).not.toBeNull();

      // member can read sections
      const memRead = await participant.client
        .from('knowledge_gap_sections')
        .select('section_id')
        .eq('section_id', sectionId);
      expect((memRead.data ?? []).length).toBe(1);

      // member cannot rename
      await participant.client
        .from('knowledge_gap_sections')
        .update({ name: 'Hacked' })
        .eq('section_id', sectionId);
      const { data: secAfter } = await admin
        .from('knowledge_gap_sections')
        .select('name')
        .eq('section_id', sectionId)
        .single();
      expect(secAfter?.name).toBe('Auth & Identity');
    });

    it('occurrences are visible iff the parent gap is', async () => {
      const gapId = await seedGap({ viewers: [participant.id] });
      const { error: occErr } = await admin.from('gap_occurrences').insert({
        gap_id: gapId,
        org_id: orgA,
        meeting_id: meetingA,
        utterance_id: `utt_${Math.random().toString(36).slice(2)}`,
        verbatim_question: 'where are we on auth migration?',
        reason: 'no_hits',
      });
      expect(occErr).toBeNull();

      const viewerSees = await participant.client
        .from('gap_occurrences')
        .select('occurrence_id')
        .eq('gap_id', gapId);
      expect((viewerSees.data ?? []).length).toBe(1);

      const nonViewerSees = await nonParticipant.client
        .from('gap_occurrences')
        .select('occurrence_id')
        .eq('gap_id', gapId);
      expect((nonViewerSees.data ?? []).length).toBe(0);
    });

    it('cross-org isolation: an outsider cannot see org A gaps or sections', async () => {
      const gapId = await seedGap({ shared: true }); // shared within org A only
      expect(await canSelectGap(outsider, gapId)).toBe(false);
      const secs = await outsider.client
        .from('knowledge_gap_sections')
        .select('section_id')
        .eq('org_id', orgA);
      expect((secs.data ?? []).length).toBe(0);
    });

    it('notifications are private to the recipient', async () => {
      const gapId = await seedGap({ viewers: [participant.id] });
      await admin.from('notifications').insert({
        user_id: participant.id,
        org_id: orgA,
        type: 'gap_assigned',
        gap_id: gapId,
        actor_id: manager.id,
      });
      const mine = await participant.client.from('notifications').select('notification_id');
      expect((mine.data ?? []).length).toBeGreaterThanOrEqual(1);
      const theirs = await nonParticipant.client.from('notifications').select('notification_id');
      expect((theirs.data ?? []).length).toBe(0);
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
  await addMember(admin, org.id as string, userId, role);
  return org.id as string;
}

async function addMember(
  admin: SupabaseClient,
  orgId: string,
  userId: string,
  role: 'manager' | 'member',
): Promise<void> {
  const { error } = await admin
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role, can_invite_bot: role === 'manager' });
  if (error !== null) {
    throw new Error(`Failed to add member: ${error.message}`);
  }
}
