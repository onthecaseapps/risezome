import type { ReactElement } from 'react';
import { requireSuperAdmin } from '../../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../../_lib/supabase-server';
import { roleLabel } from '../../../_lib/roles';

/**
 * Settings → Audit log (permissions overhaul U7). SUPER-ADMIN ONLY.
 *
 * requireSuperAdmin() redirects every non-super_admin away (app-layer
 * defense-in-depth). The permission_audit_log read itself goes through the
 * RLS-scoped authed client: the table's SELECT policy is is_super_admin(org_id),
 * so a non-super_admin would read ZERO rows even if they reached this code — RLS
 * is the real boundary; the route guard is the UX layer.
 *
 * Two enrichment reads stay on service-role (mirroring the members page): actor
 * display names come from the admin auth API (cannot run under RLS), and target
 * meeting titles are read org-scoped (the audit row already proves the actor's
 * org context). Both are presentation-only labels.
 *
 * This is intentionally BASIC (plan U7 / Scope Boundaries): a newest-first table.
 * Export + richer filtering are deferred.
 */

const ACTION_LABEL: Record<string, string> = {
  // Current (teams restructure) actions.
  role_change: 'Role change',
  master_key_access: 'Master-key access',
  team_change: 'Team change',
  team_membership_change: 'Team membership change',
  gap_assignment: 'Gap assignment',
  // Historical (pre-attendees-only) actions — retained so old rows still label.
  privacy_change: 'Privacy change',
  admin_override: 'Admin override',
};

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

  // Resolve actor display names (admin auth API — cannot run under RLS).
  const actorIds = Array.from(new Set(rows.map((r) => r.actorId)));
  const actorName = new Map<string, string>();
  await Promise.all(
    actorIds.map(async (id) => {
      const { data: u } = await service.auth.admin.getUserById(id);
      const email = u?.user?.email ?? id;
      const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : null;
      actorName.set(id, name ?? email);
    }),
  );

  // Resolve target meeting titles (service-role, org-scoped).
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

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6">
        <p className="text-xs uppercase tracking-wider text-muted">Settings</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1.5 text-sm text-muted">
          Every privileged permission event in <span className="text-fg">{orgName}</span> — privacy
          changes, admin overrides, role changes, and master-key access. Visible to Super Admins
          only; the log is append-only.
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center text-sm text-muted">
          No permission events recorded yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-[auto_1fr_1fr_1fr_2fr] gap-4 border-b border-border bg-card/40 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <span>When</span>
            <span>Actor</span>
            <span>Action</span>
            <span>Target</span>
            <span>Detail</span>
          </div>
          <ul>
            {rows.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[auto_1fr_1fr_1fr_2fr] items-start gap-4 border-b border-border px-5 py-3 text-sm last:border-b-0"
              >
                <span className="whitespace-nowrap text-muted" title={r.createdAt}>
                  {formatWhen(r.createdAt)}
                </span>
                <span className="truncate text-fg" title={actorName.get(r.actorId) ?? r.actorId}>
                  {actorName.get(r.actorId) ?? r.actorId}
                </span>
                <span className="text-fg">{ACTION_LABEL[r.action] ?? r.action}</span>
                <span className="truncate text-muted">
                  {r.targetMeetingId !== null ? (
                    <a
                      href={`/meetings/${r.targetMeetingId}/review`}
                      className="text-accent hover:underline"
                      title={meetingTitle.get(r.targetMeetingId) ?? r.targetMeetingId}
                    >
                      {meetingTitle.get(r.targetMeetingId) ?? 'Meeting'}
                    </a>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="text-muted">{describeDetail(r.action, r.detail)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Human-readable old→new summary for a row, by action type. */
function describeDetail(action: string, detail: Record<string, unknown> | null): string {
  if (detail === null) return '—';
  if (action === 'role_change') {
    const oldR = typeof detail['old_role'] === 'string' ? roleLabel(detail['old_role']) : '—';
    const newR = typeof detail['new_role'] === 'string' ? roleLabel(detail['new_role']) : '—';
    return `${oldR} → ${newR}`;
  }
  if (action === 'privacy_change' || action === 'admin_override') {
    const oldL = privacyLabel(detail['old']);
    const newL = privacyLabel(detail['new']);
    return `${oldL} → ${newL}`;
  }
  if (action === 'master_key_access') {
    // Attendees-only (U2): the master-key audit detail now carries {reason}
    // instead of a privacy level.
    return 'Viewed (master key)';
  }
  return JSON.stringify(detail);
}

function privacyLabel(v: unknown): string {
  if (typeof v !== 'string') return '—';
  return HISTORICAL_PRIVACY_LABEL[v] ?? v;
}
