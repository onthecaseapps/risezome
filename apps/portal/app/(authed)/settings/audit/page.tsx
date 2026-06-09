import type { ReactElement } from 'react';
import { requireSuperAdmin } from '../../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../../_lib/supabase-server';
import { roleLabel } from '../../../_lib/roles';
import { AuditLogClient, type AuditEntry, type Category } from './_audit-log-client';

/**
 * Settings → Audit log (permissions overhaul U7 + redesign). SUPER-ADMIN ONLY.
 *
 * requireSuperAdmin() redirects every non-super_admin away (app-layer
 * defense-in-depth). The permission_audit_log read itself goes through the
 * RLS-scoped authed client: the table's SELECT policy is is_super_admin(org_id),
 * so a non-super_admin would read ZERO rows even if they reached this code — RLS
 * is the real boundary; the route guard is the UX layer.
 *
 * Enrichment reads stay on service-role (mirroring the members page): actor +
 * target display names come from the admin auth API (cannot run under RLS), and
 * target meeting titles / team names are read org-scoped (the audit row already
 * proves the actor's org context). All presentation-only labels.
 *
 * This server component does ALL the async work and hands a fully serialized,
 * search-ready `entries` array to the client (search / filter / CSV export /
 * grouping / expand are pure-render from props — no further awaits client-side).
 */

/**
 * Historical privacy-level labels. The privacy ladder is gone (attendees-only,
 * U2), but pre-existing `privacy_change`/`admin_override` rows still carry these
 * stored values, so we inline the labels here instead of importing the deleted
 * privacy-levels module.
 */
const HISTORICAL_PRIVACY_LABEL: Record<string, string> = {
  only_me: 'Only me',
  only_participants: 'Only participants',
  only_teammates: 'Only teammates (workspace)',
};

/**
 * action → category. Two team actions collapse into one "Team membership"
 * category. NOTE: the mockup also showed a "Bot setting" category, but there is
 * NO bot-setting audit action in the system yet (bot-setting auditing isn't
 * implemented) — so it's intentionally omitted. Add a row here when it lands.
 */
const ACTION_CATEGORY: Record<string, Category> = {
  privacy_change: 'privacy_change',
  role_change: 'role_change',
  team_change: 'team_membership',
  team_membership_change: 'team_membership',
  master_key_access: 'master_key_access',
  admin_override: 'admin_override',
  gap_assignment: 'gap_assignment',
};

interface AuditRow {
  id: number;
  actorId: string;
  action: string;
  targetMeetingId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export default async function AuditLogPage(): Promise<ReactElement> {
  const { orgId, orgName } = await requireSuperAdmin();
  const supabase = await createServerClient();
  const service = createServiceRoleClient();

  const { data: logRows } = await supabase
    .from('permission_audit_log')
    .select('id, actor_id, action, target_meeting_id, detail, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(200);

  const rows: AuditRow[] = (logRows ?? []).map((r) => ({
    id: r.id as number,
    actorId: r.actor_id as string,
    action: r.action as string,
    targetMeetingId: (r.target_meeting_id as string | null) ?? null,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    createdAt: r.created_at as string,
  }));

  // ── Resolve user display names (actors + every target user referenced) ──────
  // detail.user_id appears on role_change + team_membership_change; detail
  // .assignee_id on gap_assignment. Dedupe actor + target ids into ONE batch
  // against the admin auth API (cannot run under RLS).
  const userIds = new Set<string>();
  for (const r of rows) {
    userIds.add(r.actorId);
    const uid = stringField(r.detail, 'user_id');
    if (uid !== null) userIds.add(uid);
    const aid = stringField(r.detail, 'assignee_id');
    if (aid !== null) userIds.add(aid);
  }
  const userName = new Map<string, string>();
  await Promise.all(
    Array.from(userIds).map(async (id) => {
      const { data: u } = await service.auth.admin.getUserById(id);
      const email = u?.user?.email ?? id;
      const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : null;
      userName.set(id, name ?? email);
    }),
  );

  // ── Resolve target meeting titles (service-role, org-scoped) ────────────────
  const meetingIds = Array.from(
    new Set(rows.map((r) => r.targetMeetingId).filter((id): id is string => id !== null)),
  );
  const meetingTitle = new Map<string, string>();
  if (meetingIds.length > 0) {
    const { data: mRows } = await service
      .from('meetings')
      .select('meeting_id, title')
      .eq('org_id', orgId)
      .in('meeting_id', meetingIds);
    for (const m of mRows ?? []) {
      const t = (m.title as string | null) ?? '';
      meetingTitle.set(m.meeting_id as string, t.length > 0 ? t : 'Untitled meeting');
    }
  }

  // ── Resolve team names (service-role, org-scoped) ───────────────────────────
  const teamIds = new Set<string>();
  for (const r of rows) {
    const tid = stringField(r.detail, 'team_id');
    if (tid !== null) teamIds.add(tid);
  }
  const teamName = new Map<string, string>();
  if (teamIds.size > 0) {
    const { data: tRows } = await service
      .from('teams')
      .select('team_id, name')
      .eq('org_id', orgId)
      .in('team_id', Array.from(teamIds));
    for (const t of tRows ?? []) {
      teamName.set(t.team_id as string, (t.name as string | null) ?? 'a team');
    }
  }

  // ── Build fully-enriched, serializable entries ──────────────────────────────
  const resolveUser = (id: string | null): string => (id !== null ? userName.get(id) ?? id : '—');
  const resolveTeam = (id: string | null): string => (id !== null ? teamName.get(id) ?? 'a team' : 'a team');

  const entries: AuditEntry[] = rows.map((r) => {
    const category = ACTION_CATEGORY[r.action] ?? 'admin_override';
    const sensitive = r.action === 'master_key_access';
    const title = CATEGORY_TITLE[category];
    const description = describeDetail(r, resolveUser, resolveTeam);
    const { targetLabel, targetHref } = resolveTarget(r, meetingTitle, resolveUser);
    const actorName = userName.get(r.actorId) ?? r.actorId;
    const searchText = [actorName, title, description, targetLabel ?? '']
      .join(' ')
      .toLowerCase();
    return {
      id: r.id,
      createdAt: r.createdAt,
      actorId: r.actorId,
      actorName,
      category,
      action: r.action,
      title,
      sensitive,
      description,
      targetLabel,
      targetHref,
      detail: r.detail,
      searchText,
    };
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1.5 text-sm text-muted">
          Every privileged permission event in <span className="text-fg">{orgName}</span>: privacy
          changes, admin overrides, role changes, and master-key access. Visible to Super Admins
          only; the log is append-only.
        </p>
      </header>

      <AuditLogClient entries={entries} orgName={orgName} />
    </div>
  );
}

/** Per-category event title shown in the EVENT cell (matches CATEGORY_META). */
const CATEGORY_TITLE: Record<Category, string> = {
  privacy_change: 'Privacy change',
  role_change: 'Role change',
  team_membership: 'Team membership',
  master_key_access: 'Master-key access',
  admin_override: 'Admin override',
  gap_assignment: 'Gap assignment',
};

/** Human-readable description for a row, by action type. */
function describeDetail(
  r: AuditRow,
  resolveUser: (id: string | null) => string,
  resolveTeam: (id: string | null) => string,
): string {
  const detail = r.detail;
  if (detail === null) return '';

  if (r.action === 'role_change') {
    const oldR = typeof detail['old_role'] === 'string' ? roleLabel(detail['old_role']) : '—';
    const newR = typeof detail['new_role'] === 'string' ? roleLabel(detail['new_role']) : '—';
    return `${oldR} → ${newR}`;
  }

  if (r.action === 'team_change') {
    const act = stringField(detail, 'action');
    const name = stringField(detail, 'name');
    if (act === 'create') return `Created ${name ?? 'team'}`;
    if (act === 'rename') return `Renamed to ${name ?? 'team'}`;
    if (act === 'archive') return 'Archived team';
    return '';
  }

  if (r.action === 'team_membership_change') {
    const act = stringField(detail, 'action');
    const who = resolveUser(stringField(detail, 'user_id'));
    const team = resolveTeam(stringField(detail, 'team_id'));
    if (act === 'add') return `Added ${who} to ${team}`;
    if (act === 'remove') return `Removed ${who} from ${team}`;
    return '';
  }

  if (r.action === 'master_key_access') {
    const reason = stringField(detail, 'reason') ?? 'unspecified';
    return `Accessed under master key (${reason})`;
  }

  if (r.action === 'privacy_change' || r.action === 'admin_override') {
    return `${privacyLabel(detail['old'])} → ${privacyLabel(detail['new'])}`;
  }

  if (r.action === 'gap_assignment') {
    return `Assigned to ${resolveUser(stringField(detail, 'assignee_id'))}`;
  }

  return '';
}

/**
 * Resolve the `· {targetLabel}` shown next to the event title (+ optional link):
 *  - role_change → the affected user (no link)
 *  - master_key_access / privacy_change / admin_override → the meeting (link to
 *    review when target_meeting_id is set)
 */
function resolveTarget(
  r: AuditRow,
  meetingTitle: Map<string, string>,
  resolveUser: (id: string | null) => string,
): { targetLabel: string | null; targetHref: string | null } {
  if (r.action === 'role_change') {
    const uid = stringField(r.detail, 'user_id');
    if (uid !== null) return { targetLabel: resolveUser(uid), targetHref: null };
  }
  if (r.targetMeetingId !== null) {
    return {
      targetLabel: meetingTitle.get(r.targetMeetingId) ?? 'Meeting',
      targetHref: `/meetings/${r.targetMeetingId}/review`,
    };
  }
  return { targetLabel: null, targetHref: null };
}

function privacyLabel(v: unknown): string {
  if (typeof v !== 'string') return '—';
  return HISTORICAL_PRIVACY_LABEL[v] ?? v;
}

function stringField(detail: Record<string, unknown> | null, key: string): string | null {
  if (detail === null) return null;
  const v = detail[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
