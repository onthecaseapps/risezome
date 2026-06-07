'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Change a member's role. Scoped to the caller's org. The org_members RLS forbids
 * a user writing another member's row, so these use the service-role client with
 * an explicit role check.
 *
 * PRIVILEGE GATE (KTD2; super_admin is the master-key tier):
 *   - member <-> manager changes require ADMIN power (requireAdmin: manager OR
 *     super_admin).
 *   - GRANTING super_admin (new role is 'super_admin') OR DEMOTING/removing an
 *     existing super_admin (target's CURRENT role is 'super_admin') requires the
 *     caller to BE a super_admin. Otherwise a manager(Admin) could self-promote to
 *     the master-key tier — a privilege escalation. A non-super_admin caller on
 *     either of those paths gets 'forbidden'.
 * The last-privileged-user DB trigger is the atomic backstop (an org can never be
 * left with zero super_admins or zero admins-or-above).
 */
export async function changeRoleAction(userId: string, role: string): Promise<ActionResult> {
  if (role !== 'manager' && role !== 'member' && role !== 'super_admin') {
    return { ok: false, error: 'invalid_role' };
  }
  const { user, orgId, role: callerRole } = await requireAdmin();
  const service = createServiceRoleClient();

  // Capture the old role for the audit trail (U5) AND for the super_admin gate
  // below. Org-scoped read.
  const { data: prior } = await service
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const oldRole = (prior?.role as string | undefined) ?? null;

  // Minting OR removing a super_admin (the master-key tier) requires an existing
  // super_admin caller — requireAdmin alone (manager) is not enough, else a
  // manager could self-promote to super_admin.
  const touchesSuperAdmin = role === 'super_admin' || oldRole === 'super_admin';
  if (touchesSuperAdmin && callerRole !== 'super_admin') {
    return { ok: false, error: 'forbidden' };
  }

  const { error } = await service
    .from('org_members')
    .update({ role })
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error !== null) return { ok: false, error: lastManagerError(error.message) };

  // Append an append-only role_change audit row (service-role; U5). Best-effort:
  // the role change already committed, so a failed audit insert must not surface
  // as a failed role change — log and continue.
  if (oldRole !== role) {
    const { error: auditErr } = await service.from('permission_audit_log').insert({
      org_id: orgId,
      actor_id: user.id,
      action: 'role_change',
      target_meeting_id: null,
      detail: { user_id: userId, old_role: oldRole, new_role: role },
    });
    if (auditErr !== null) {
      console.error('[member-actions] role_change audit insert failed:', auditErr.message);
    }
  }

  revalidatePath('/settings/teams');
  return { ok: true };
}

/** Grant or revoke a member's "can invite the bot" permission. */
export async function setCanInviteBotAction(userId: string, value: boolean): Promise<ActionResult> {
  const { orgId } = await requireAdmin();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('org_members')
    .update({ can_invite_bot: value })
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/settings/teams');
  return { ok: true };
}

/** Remove a member from the workspace. The last-manager trigger blocks removing
 *  the sole manager. */
export async function removeMemberAction(userId: string): Promise<ActionResult> {
  const { orgId } = await requireAdmin();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('org_members')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error !== null) return { ok: false, error: lastManagerError(error.message) };
  revalidatePath('/settings/teams');
  return { ok: true };
}

/** Map the last-privileged-user trigger's exceptions to friendly codes. The
 *  trigger guards both invariants: an org can never be left with zero
 *  admins-or-above ("last manager") nor zero super_admins ("last super_admin"). */
function lastManagerError(message: string): string {
  if (message.includes('last super_admin')) return 'last_super_admin';
  if (message.includes('last manager')) return 'last_manager';
  return message;
}
