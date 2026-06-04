'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import {
  createServerClient,
  createServiceRoleClient,
} from '../../../_lib/supabase-server';
import {
  PRIVACY_RANK,
  isPrivacyLevel,
  type PrivacyLevel,
} from '../../../_lib/privacy-levels';
import { isAdminRole } from '../../../_lib/roles';

/**
 * Meeting-privacy write action (permissions overhaul U4; KTD6, KTD7).
 *
 * `setMeetingPrivacy(meetingId, level)` changes a meeting's privacy_level and
 * records a permission_audit_log row. There are TWO write paths, chosen by who
 * the caller is relative to the meeting and whether the requested level is below
 * the org floor:
 *
 *   OWNER path (action='privacy_change'):
 *     The caller owns the meeting (meetings.user_id = caller). A plain
 *     SERVICE-ROLE, org-scoped UPDATE. The floor trigger (20260608020000) still
 *     applies, so an owner CANNOT set a level below the org floor — the trigger
 *     rejects it and we surface 'below_floor'. This is the floor-bound path.
 *
 *   ADMIN-OVERRIDE path (action='admin_override'):
 *     The caller is an admin (manager OR super_admin via is_org_admin) acting on
 *     a meeting — typically someone else's, and/or below the floor. It goes
 *     through the SECURITY DEFINER `admin_override_meeting_privacy` RPC, which
 *     sets the transaction-local floor-bypass GUC + UPDATE atomically and
 *     SELF-CHECKS is_org_admin inside the function (so a non-admin calling it is
 *     rejected by the DB). This path is floor-EXEMPT (KTD7/R12).
 *
 * PATH DECISION (documented):
 *   - Caller is the owner AND the level is at/above the floor  -> OWNER path.
 *   - Caller is an admin (and either not the owner, or wants a below-floor level)
 *                                                              -> ADMIN-OVERRIDE.
 *   - Caller is the owner but the requested level is below the floor: the owner
 *     path's trigger would reject it. If the owner is ALSO an admin we still keep
 *     them on the floor-bound owner path (an admin lowering THEIR OWN meeting
 *     below the floor must consciously do so — and the action returns
 *     'below_floor' so the UI can offer the override affordance). A pure owner
 *     (non-admin) below-floor request is rejected, by design (R10).
 *   - Caller is neither owner nor admin                        -> rejected.
 *
 * Both paths append exactly one permission_audit_log row (service-role,
 * org-scoped) with detail={old,new}. RLS forbids clients writing meetings.role/
 * privacy directly (service-role-only writes; KTD6), so this action is the only
 * sanctioned mutation surface.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

export async function setMeetingPrivacy(
  meetingId: string,
  level: string,
): Promise<ActionResult> {
  if (!isPrivacyLevel(level)) {
    return { ok: false, error: 'invalid_level' };
  }

  const { user, orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  // Load the meeting (service-role, org-scoped) to get owner + current level.
  const { data: meeting, error: loadErr } = await service
    .from('meetings')
    .select('meeting_id, user_id, privacy_level')
    .eq('org_id', orgId)
    .eq('meeting_id', meetingId)
    .maybeSingle();
  if (loadErr !== null) return { ok: false, error: loadErr.message };
  if (meeting === null) return { ok: false, error: 'not_found' };

  const oldLevel = meeting.privacy_level as PrivacyLevel;
  const isOwner = (meeting.user_id as string) === user.id;

  // Resolve admin status from the caller's org role (the RLS RPC self-checks too,
  // but we use it to choose the path + to reject non-owner non-admins early).
  const { data: membership } = await service
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  const role = (membership?.role as string | undefined) ?? null;
  const isAdmin = role !== null && isAdminRole(role);

  if (!isOwner && !isAdmin) {
    return { ok: false, error: 'forbidden' };
  }

  // No-op short-circuit (still allowed; just nothing to record).
  if (oldLevel === level) return { ok: true };

  const belowFloor =
    PRIVACY_RANK[level] < PRIVACY_RANK[oldLevel] ? await isBelowFloor(service, orgId, level) : false;
  // ADMIN-OVERRIDE when the caller is acting as an admin on a meeting they don't
  // own, OR an admin deliberately taking a below-floor level on someone's meeting.
  const useOverride = isAdmin && (!isOwner || belowFloor);

  if (useOverride) {
    // The override RPC self-checks is_org_admin and runs under the caller's JWT,
    // so it must go through the user-scoped (authenticated) client.
    const userClient = await createServerClient();
    const { error: rpcErr } = await userClient.rpc('admin_override_meeting_privacy', {
      p_meeting_id: meetingId,
      p_level: level,
    });
    if (rpcErr !== null) return { ok: false, error: rpcErr.message };
    await appendAudit(service, orgId, user.id, 'admin_override', meetingId, oldLevel, level);
  } else {
    // OWNER path: floor-bound service-role UPDATE. The trigger rejects below-floor.
    const { error: updErr } = await service
      .from('meetings')
      .update({ privacy_level: level })
      .eq('org_id', orgId)
      .eq('meeting_id', meetingId);
    if (updErr !== null) {
      if (updErr.message.includes('more private than the org floor')) {
        return { ok: false, error: 'below_floor' };
      }
      return { ok: false, error: updErr.message };
    }
    await appendAudit(service, orgId, user.id, 'privacy_change', meetingId, oldLevel, level);
  }

  revalidatePath(`/meetings/${meetingId}/review`);
  return { ok: true };
}

/** Is `level` more private than the org's floor? (Service-role read of config.) */
async function isBelowFloor(
  service: ReturnType<typeof createServiceRoleClient>,
  orgId: string,
  level: PrivacyLevel,
): Promise<boolean> {
  const { data } = await service
    .from('org_privacy_config')
    .select('privacy_floor')
    .eq('org_id', orgId)
    .maybeSingle();
  const floor = (data?.privacy_floor as PrivacyLevel | undefined) ?? 'only_me';
  return PRIVACY_RANK[level] < PRIVACY_RANK[floor];
}

/** Append one audit row (service-role, org-scoped). Detail carries old->new. */
async function appendAudit(
  service: ReturnType<typeof createServiceRoleClient>,
  orgId: string,
  actorId: string,
  action: 'privacy_change' | 'admin_override',
  meetingId: string,
  oldLevel: string,
  newLevel: string,
): Promise<void> {
  // Best-effort: the privacy change already committed, so a failed audit insert
  // must not surface as a failed change — log and continue (mirrors
  // member-actions.ts role_change auditing).
  const { error } = await service.from('permission_audit_log').insert({
    org_id: orgId,
    actor_id: actorId,
    action,
    target_meeting_id: meetingId,
    detail: { old: oldLevel, new: newLevel },
  });
  if (error !== null) {
    console.error('[privacy-action] audit insert failed:', error.message);
  }
}
