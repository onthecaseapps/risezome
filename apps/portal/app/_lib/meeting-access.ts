import { createServiceRoleClient } from './supabase-server';
import type { OrgRole } from './auth';

/**
 * App-layer master-key audit (permissions overhaul U5 Part B; KTD5).
 *
 * An RLS SELECT policy cannot reliably append an audit row, so the "a super_admin
 * used the master key" trail is recorded HERE — at the meeting read paths — when a
 * super_admin views a meeting they would NOT otherwise be entitled to. RLS (U3's
 * can_access_meeting) already GRANTS the super_admin the row; this helper adds the
 * audit only when the access was a genuine master-key bypass.
 *
 * "Master-key access" predicate (isMasterKeyAccess, pure + unit-tested):
 *   role === 'super_admin'           — only the master-key tier can bypass, AND
 *   viewer is NOT the owner          — owners are entitled regardless, AND
 *   the level is NOT only_teammates  — every org member is entitled to those, AND
 *   for only_participants: viewer is NOT a participant (participants are entitled).
 * i.e. only_me (non-owner super_admin) OR only_participants-and-not-a-participant.
 * For only_teammates the super_admin is entitled like any teammate, so it is NOT a
 * master-key access and is NOT logged.
 */

export interface MeetingForAccess {
  org_id: string;
  /** Owner of the meeting (meetings.user_id). */
  user_id: string;
  privacy_level: 'only_me' | 'only_participants' | 'only_teammates' | string;
}

export interface ViewerContext {
  userId: string;
  orgId: string;
  role: OrgRole;
}

/**
 * Pure decision: is THIS view a Super-Admin master-key access (an access only the
 * master key grants)? `isParticipant` is whether the viewer attended the meeting;
 * it only matters for only_participants. No I/O — unit-testable.
 */
export function isMasterKeyAccess(args: {
  role: OrgRole;
  viewerId: string;
  ownerId: string;
  privacyLevel: string;
  isParticipant: boolean;
}): boolean {
  const { role, viewerId, ownerId, privacyLevel, isParticipant } = args;
  if (role !== 'super_admin') return false;
  // The owner is always entitled — never a master-key access.
  if (viewerId === ownerId) return false;
  switch (privacyLevel) {
    case 'only_me':
      // Non-owner super_admin: only the master key grants this.
      return true;
    case 'only_participants':
      // A participating super_admin is entitled as a participant; a non-
      // participant gets in only via the master key.
      return !isParticipant;
    case 'only_teammates':
      // Every org member is entitled; not a master-key access.
      return false;
    default:
      return false;
  }
}

/**
 * Best-effort recorder: if this view is a master-key access, append a
 * master_key_access audit row (service-role, org-scoped). NEVER throws to the page
 * — a failed audit write must not break the read; we log and return. The viewer's
 * participation is resolved here (only when needed: a non-owner super_admin on an
 * only_participants meeting) to keep the common case I/O-free.
 */
export async function recordMasterKeyAccessIfNeeded(args: {
  viewer: ViewerContext;
  meeting: MeetingForAccess;
  meetingId: string;
}): Promise<void> {
  const { viewer, meeting, meetingId } = args;

  // Cheap gates first: only a non-owner super_admin on a restricted level can be a
  // master-key access — skip everything else without any I/O.
  if (viewer.role !== 'super_admin') return;
  if (viewer.userId === meeting.user_id) return;
  if (meeting.privacy_level === 'only_teammates') return;

  try {
    const service = createServiceRoleClient();

    let isParticipant = false;
    if (meeting.privacy_level === 'only_participants') {
      const { data } = await service
        .from('meeting_participants')
        .select('user_id')
        .eq('meeting_id', meetingId)
        .eq('user_id', viewer.userId)
        .maybeSingle();
      isParticipant = data !== null;
    }

    if (
      !isMasterKeyAccess({
        role: viewer.role,
        viewerId: viewer.userId,
        ownerId: meeting.user_id,
        privacyLevel: meeting.privacy_level,
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
      detail: { privacy_level: meeting.privacy_level },
    });
    if (error !== null) {
      console.error('[meeting-access] master_key_access audit insert failed:', error.message);
    }
  } catch (err) {
    // Best-effort: never let an audit failure break the page.
    console.error('[meeting-access] master-key audit recorder error:', err);
  }
}
