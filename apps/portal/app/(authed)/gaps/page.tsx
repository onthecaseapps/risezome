import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { listAuthUserNames } from '../../_lib/auth-admin';
import { isAdminRole } from '../../_lib/roles';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { GapsClient } from './_client';
import type {
  GapView,
  SectionView,
  OrgMember,
  NotificationView,
  AssignedQuestionView,
  GapStatus,
} from './_types';

/**
 * Knowledge gaps — questions Risezome couldn't answer in meetings, captured
 * automatically, deduped, demand-ranked, and grouped into sections.
 *
 * Server component. Reads go through the RLS-scoped authed client
 * (createServerClient): a member sees only gaps they can view (viewer /
 * assignee / shared), a manager sees every org gap. Per-gap occurrence
 * aggregates (people / meetings / moments / phrasings) come from the
 * knowledge_gaps_stats RPC in one round trip.
 *
 * PERF: the page deliberately does NOT load gap_occurrences — that was an
 * unbounded fetch (every occurrence for every gap, growing with org age) on the
 * page's critical path. The drawer lazy-loads one gap's occurrences on open via
 * listGapOccurrencesAction. Independent reads are batched into two Promise.all
 * waves (wave 2 needs the gap ids from wave 1) instead of nine serial awaits.
 *
 * Member display names are resolved via the service-role admin API (same as
 * the members page) — needed for owner avatars and the manager assignee picker.
 */
export default async function GapsPage(): Promise<ReactElement> {
  const { orgId, user, role } = await requireAuthedUserWithOrg();
  // Admin power = manager OR super_admin (KTD2): super_admin inherits the
  // manager surface (assign / curate / share).
  const isManager = isAdminRole(role);
  const supabase = await createServerClient();
  // Service-role use here is the documented U5 exception: the roster/name
  // resolution needs every member, which a non-manager caller can't read under
  // RLS, and the admin auth API can't run under RLS at all. Names only, own org.
  const service = createServiceRoleClient();

  // ── wave 1: independent reads, one round-trip wall ─────────────────────────
  const [
    { data: gapRows },
    { data: sectionRows },
    { data: memberRows },
    authNames,
    { data: notifRows },
    { data: assignedRows },
  ] = await Promise.all([
    supabase
      .from('knowledge_gaps')
      .select(
        'gap_id, section_id, title, status, assignee_id, frequency, shared_with_org, section_pinned, reopened_after_close, first_asked_at, last_asked_at, assigned_by, assigned_at, resolved_by, resolved_at, dismissed_by, dismissed_at, created_at',
      )
      .eq('org_id', orgId)
      .order('frequency', { ascending: false }),
    supabase
      .from('knowledge_gap_sections')
      .select('section_id, name, color, name_locked')
      .eq('org_id', orgId)
      .order('name', { ascending: true }),
    service
      .from('org_members')
      .select('user_id, role, joined_at')
      .eq('org_id', orgId)
      .order('joined_at', { ascending: true }),
    listAuthUserNames(service),
    supabase
      .from('notifications')
      .select('notification_id, type, gap_id, actor_id, created_at')
      .eq('org_id', orgId)
      .eq('type', 'gap_assigned')
      .is('read_at', null)
      .order('created_at', { ascending: false }),
    // U8 — "Assigned to you": SECURITY DEFINER RPC scoped to the caller; returns
    // ONLY question/asker/recurrence/status. Degrades to [] on failure.
    supabase.rpc('list_assigned_questions'),
  ]);

  const gaps = (gapRows ?? []) as Array<{
    gap_id: string;
    section_id: string | null;
    title: string;
    status: 'open' | 'resolved' | 'dismissed';
    assignee_id: string | null;
    frequency: number;
    shared_with_org: boolean;
    section_pinned: boolean;
    reopened_after_close: boolean;
    first_asked_at: string | null;
    last_asked_at: string | null;
    assigned_by: string | null;
    assigned_at: string | null;
    resolved_by: string | null;
    resolved_at: string | null;
    dismissed_by: string | null;
    dismissed_at: string | null;
    created_at: string;
  }>;
  const gapIds = gaps.map((g) => g.gap_id);

  const sections: SectionView[] = (sectionRows ?? []).map((s) => ({
    sectionId: s.section_id as string,
    name: s.name as string,
    color: s.color as string,
    nameLocked: s.name_locked as boolean,
  }));

  // ── wave 2: per-gap aggregates (needs gapIds) ──────────────────────────────
  const stats = new Map<
    string,
    { people: number; meetings: number; moments: number; phrasings: number; canViewContent: boolean }
  >();
  // On a whole-RPC failure the render hint degrades OPEN (canViewContent: true
  // with zeroed counts) — NOT closed: canViewContent is only a render hint, the
  // authoritative gate is the gap_occurrences RLS the drawer's lazy fetch goes
  // through (a true non-content viewer gets [] back regardless). Failing closed
  // here showed actual meeting participants the "you weren't in the meeting"
  // gate whenever the RPC blipped. Logged loudly — this should be rare.
  let statsFailed = false;
  if (gapIds.length > 0) {
    const { data: statRows, error: statErr } = await supabase.rpc('knowledge_gaps_stats', {
      p_gap_ids: gapIds,
    });
    if (statErr === null && Array.isArray(statRows)) {
      for (const r of statRows as Array<{
        gap_id: string;
        people: number;
        meetings: number;
        moments: number;
        phrasings: number;
        can_view_content: boolean;
      }>) {
        stats.set(r.gap_id, {
          people: r.people ?? 0,
          meetings: r.meetings ?? 0,
          moments: r.moments ?? 0,
          phrasings: r.phrasings ?? 0,
          canViewContent: r.can_view_content ?? false,
        });
      }
    } else {
      statsFailed = true;
      console.error(
        `[gaps] knowledge_gaps_stats failed (org=${orgId}, gaps=${String(gapIds.length)}):`,
        statErr?.message ?? 'no rows',
      );
    }
  }

  const members: OrgMember[] = [];
  const nameById = new Map<string, string>();
  for (const m of memberRows ?? []) {
    const userId = m.user_id as string;
    const name = authNames.get(userId) ?? userId;
    nameById.set(userId, name);
    members.push({ userId, name, role: m.role as string });
  }

  const gapViews: GapView[] = gaps.map((g) => {
    const s = stats.get(g.gap_id) ?? {
      people: 0,
      meetings: 0,
      moments: 0,
      phrasings: 0,
      // Per-gap absence with a healthy RPC = genuinely gated; whole-RPC
      // failure = unknown, degrade open (RLS is the real gate; see above).
      canViewContent: statsFailed,
    };
    return {
      gapId: g.gap_id,
      sectionId: g.section_id,
      title: g.title,
      status: g.status,
      assigneeId: g.assignee_id,
      assigneeName: g.assignee_id !== null ? (nameById.get(g.assignee_id) ?? null) : null,
      frequency: g.frequency,
      sharedWithOrg: g.shared_with_org,
      sectionPinned: g.section_pinned,
      reopenedAfterClose: g.reopened_after_close,
      firstAskedAtIso: g.first_asked_at,
      lastAskedAtIso: g.last_asked_at,
      assignedByName: g.assigned_by !== null ? (nameById.get(g.assigned_by) ?? null) : null,
      assignedAtIso: g.assigned_at,
      people: s.people,
      meetings: s.meetings,
      moments: s.moments,
      // "+N phrasings" pill = distinct verbatim minus the canonical title.
      extraPhrasings: Math.max(0, s.phrasings - 1),
      canViewContent: s.canViewContent,
      // Lazy: the drawer fetches one gap's occurrences on open.
      occurrences: [],
    };
  });

  // Unread gap_assigned notifications for the current user → fresh-assignment
  // toasts (U12). RLS scopes these to the recipient; gap title/frequency resolve
  // from data already loaded for the page.
  const gapById = new Map(gapViews.map((g) => [g.gapId, g]));
  const notifications: NotificationView[] = (notifRows ?? [])
    .map((n) => {
      const gapId = (n.gap_id as string | null) ?? null;
      const gap = gapId !== null ? (gapById.get(gapId) ?? null) : null;
      const actorId = (n.actor_id as string | null) ?? null;
      return {
        notificationId: Number(n.notification_id),
        gapId,
        gapTitle: gap?.title ?? null,
        frequency: gap?.frequency ?? 0,
        actorName: actorId !== null ? (nameById.get(actorId) ?? null) : null,
      };
    })
    .filter((n): n is NotificationView => n.gapId !== null);

  const assignedQuestions: AssignedQuestionView[] = Array.isArray(assignedRows)
    ? (assignedRows as Array<{
        gap_id: string;
        title: string;
        asker_name: string | null;
        frequency: number;
        last_asked_at: string | null;
        status: string;
      }>).map((r) => ({
        gapId: r.gap_id,
        title: r.title,
        askerName: r.asker_name,
        frequency: r.frequency ?? 0,
        lastAskedAtIso: r.last_asked_at,
        status: r.status as GapStatus,
      }))
    : [];

  return (
    <GapsClient
      gaps={gapViews}
      sections={sections}
      members={members}
      isManager={isManager}
      currentUserId={user.id}
      notifications={notifications}
      assignedQuestions={assignedQuestions}
    />
  );
}
