import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { GapsClient } from './_client';
import type {
  GapView,
  GapOccurrenceView,
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
 * knowledge_gaps_stats RPC in one round trip; if that RPC isn't present yet we
 * fall back to a plain occurrences select tallied in JS, so the page degrades
 * instead of erroring (mirrors captures / capture_card_stats).
 *
 * Member display names are resolved via the service-role admin API (same as
 * the members page) — needed for owner avatars and the manager assignee picker.
 */
export default async function GapsPage(): Promise<ReactElement> {
  const { orgId, user, role } = await requireAuthedUserWithOrg();
  const isManager = role === 'manager';
  const supabase = await createServerClient();

  const { data: gapRows } = await supabase
    .from('knowledge_gaps')
    .select(
      'gap_id, section_id, title, status, assignee_id, frequency, shared_with_org, section_pinned, reopened_after_close, first_asked_at, last_asked_at, assigned_by, assigned_at, resolved_by, resolved_at, dismissed_by, dismissed_at, created_at',
    )
    .eq('org_id', orgId)
    .order('frequency', { ascending: false });

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

  const { data: sectionRows } = await supabase
    .from('knowledge_gap_sections')
    .select('section_id, name, color, name_locked')
    .eq('org_id', orgId)
    .order('name', { ascending: true });
  const sections: SectionView[] = (sectionRows ?? []).map((s) => ({
    sectionId: s.section_id as string,
    name: s.name as string,
    color: s.color as string,
    nameLocked: s.name_locked as boolean,
  }));

  // Occurrences for the visible gaps — used for the drawer (moments + merged
  // phrasings) and meeting names. RLS scopes these to viewable gaps.
  const occByGap = new Map<string, GapOccurrenceView[]>();
  const meetingIds = new Set<string>();
  if (gapIds.length > 0) {
    const { data: occRows } = await supabase
      .from('gap_occurrences')
      .select(
        'occurrence_id, gap_id, meeting_id, utterance_id, verbatim_question, asker_name, asker_user_id, asked_at',
      )
      .in('gap_id', gapIds)
      .order('asked_at', { ascending: false });
    for (const r of occRows ?? []) {
      const gapId = r.gap_id as string;
      const meetingId = r.meeting_id as string;
      meetingIds.add(meetingId);
      const list = occByGap.get(gapId) ?? [];
      list.push({
        occurrenceId: String(r.occurrence_id),
        meetingId,
        utteranceId: (r.utterance_id as string | null) ?? null,
        verbatimQuestion: r.verbatim_question as string,
        askerName: r.asker_name as string,
        askerUserId: (r.asker_user_id as string | null) ?? null,
        askedAtIso: r.asked_at as string,
        meetingTitle: '',
      });
      occByGap.set(gapId, list);
    }
  }

  // Meeting titles for the drawer's "Open moment" rows.
  const titleByMeeting = new Map<string, string>();
  if (meetingIds.size > 0) {
    const { data: meetingRows } = await supabase
      .from('meetings')
      .select('meeting_id, title')
      .in('meeting_id', [...meetingIds]);
    for (const m of meetingRows ?? []) {
      titleByMeeting.set(m.meeting_id as string, (m.title as string) ?? '');
    }
  }
  for (const list of occByGap.values()) {
    for (const o of list) o.meetingTitle = titleByMeeting.get(o.meetingId) ?? '';
  }

  // Per-gap aggregates: prefer the single-round-trip RPC, fall back to a JS
  // tally over the occurrences we already loaded.
  const stats = new Map<
    string,
    { people: number; meetings: number; moments: number; phrasings: number; canViewContent: boolean }
  >();
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
      // Fallback (RPC absent): if we loaded any occurrences for a gap, RLS let us
      // read its content, so canViewContent is true; gaps with none default false.
      for (const [gapId, list] of occByGap.entries()) {
        const people = new Set(list.map((o) => o.askerName)).size;
        const meetings = new Set(list.map((o) => o.meetingId)).size;
        const phrasings = new Set(list.map((o) => o.verbatimQuestion)).size;
        stats.set(gapId, { people, meetings, moments: list.length, phrasings, canViewContent: true });
      }
    }
  }

  // Resolve org-member display names (owner avatar, actor lines, assignee
  // picker). This stays on service-role (U5 exception): the page is only
  // requireAuthedUserWithOrg()-gated, so a non-manager caller under RLS would
  // see only their OWN org_members row ("read own membership or all as
  // manager"), but the roster/name resolution needs every member. The admin
  // auth API (listUsers) can't run under RLS either. Names only, own org.
  const service = createServiceRoleClient();
  const { data: memberRows } = await service
    .from('org_members')
    .select('user_id, role, joined_at')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true });
  const members: OrgMember[] = [];
  const nameById = new Map<string, string>();
  // One paged listUsers call instead of an N+1 getUserById loop over members.
  const authNames = new Map<string, string>();
  const { data: authList } = await service.auth.admin.listUsers({ perPage: 1000 });
  for (const u of authList?.users ?? []) {
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    authNames.set(u.id, typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : (u.email ?? u.id));
  }
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
      canViewContent: false,
    };
    const occurrences = occByGap.get(g.gap_id) ?? [];
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
      occurrences,
    };
  });

  // Unread gap_assigned notifications for the current user → fresh-assignment
  // toasts (U12). RLS scopes these to the recipient. We resolve the actor name
  // and gap title/frequency from data already loaded for the page.
  const { data: notifRows } = await supabase
    .from('notifications')
    .select('notification_id, type, gap_id, actor_id, created_at')
    .eq('org_id', orgId)
    .eq('type', 'gap_assigned')
    .is('read_at', null)
    .order('created_at', { ascending: false });
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

  // U8 — "Assigned to you" (U5's deferred metadata-only surface). The
  // list_assigned_questions() RPC (SECURITY DEFINER, scoped to the caller)
  // returns ONLY the question, asker_name, recurrence metrics, and status — the
  // surface for a NON-attendee assignee who can't open the gap itself. Read
  // through the RLS-respecting authed client; never link these rows through to
  // the gap drawer / verbatim. Degrades to [] on any RPC failure.
  const { data: assignedRows } = await supabase.rpc('list_assigned_questions');
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
