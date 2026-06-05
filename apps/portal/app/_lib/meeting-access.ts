import { createServiceRoleClient } from './supabase-server';
import type { OrgRole } from './auth';

/**
 * App-layer master-key audit (teams restructure U2; was permissions overhaul U5).
 *
 * Access is now ATTENDEES-ONLY: a meeting and its sibling payload tables are
 * visible to its participants plus the super-admin master key (can_access_meeting,
 * 20260609030000). An RLS SELECT policy cannot reliably append an audit row, so the
 * "a super_admin used the master key" trail is recorded HERE — at the meeting read
 * paths — when a super_admin views a meeting they did NOT attend. RLS already GRANTS
 * the super_admin the row; this helper adds the audit only for the genuine bypass.
 *
 * "Master-key access" predicate (isMasterKeyAccess, pure + unit-tested):
 *   role === 'super_admin'   — only the master-key tier bypasses, AND
 *   viewer is NOT the owner   — owners are entitled regardless, AND
 *   viewer is NOT a participant — attendees are entitled.
 * i.e. a super_admin who neither owns nor attended the meeting.
 */

export interface MeetingForAccess {
  org_id: string;
  /** Owner of the meeting (meetings.user_id). */
  user_id: string;
}

export interface ViewerContext {
  userId: string;
  orgId: string;
  role: OrgRole;
}

/**
 * Pure decision: is THIS view a Super-Admin master-key access (an access only the
 * master key grants)? `isParticipant` is whether the viewer attended the meeting.
 * No I/O — unit-testable.
 */
export function isMasterKeyAccess(args: {
  role: OrgRole;
  viewerId: string;
  ownerId: string;
  isParticipant: boolean;
}): boolean {
  const { role, viewerId, ownerId, isParticipant } = args;
  if (role !== 'super_admin') return false;
  // The owner is always entitled — never a master-key access.
  if (viewerId === ownerId) return false;
  // A participating super_admin is entitled as an attendee; a non-participant
  // super_admin gets in only via the master key.
  return !isParticipant;
}

/**
 * Best-effort recorder: if this view is a master-key access, append a
 * master_key_access audit row (service-role, org-scoped). NEVER throws to the page
 * — a failed audit write must not break the read; we log and return. The viewer's
 * participation is resolved here (only when needed: a non-owner super_admin) to keep
 * the common case I/O-free.
 */
export async function recordMasterKeyAccessIfNeeded(args: {
  viewer: ViewerContext;
  meeting: MeetingForAccess;
  meetingId: string;
}): Promise<void> {
  const { viewer, meeting, meetingId } = args;

  // Cheap gates first: only a non-owner super_admin can be a master-key access —
  // skip everything else without any I/O.
  if (viewer.role !== 'super_admin') return;
  if (viewer.userId === meeting.user_id) return;

  try {
    const service = createServiceRoleClient();

    const { data } = await service
      .from('meeting_participants')
      .select('user_id')
      .eq('meeting_id', meetingId)
      .eq('user_id', viewer.userId)
      .maybeSingle();
    const isParticipant = data !== null;

    if (
      !isMasterKeyAccess({
        role: viewer.role,
        viewerId: viewer.userId,
        ownerId: meeting.user_id,
        isParticipant,
      })
    ) {
      return;
    }

    const { error } = await service.from('permission_audit_log').insert({
      org_id: meeting.org_id,
      actor_id: viewer.userId,
      action: 'master_key_access',
      target_meeting_id: meetingId,
      detail: { reason: 'attendees_only' },
    });
    if (error !== null) {
      console.error('[meeting-access] master_key_access audit insert failed:', error.message);
    }
  } catch (err) {
    // Best-effort: never let an audit failure break the page.
    console.error('[meeting-access] master-key audit recorder error:', err);
  }
}
