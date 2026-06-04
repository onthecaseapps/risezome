'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Change a member's role. Admin-only (manager OR super_admin via requireAdmin);
 * scoped to the admin's org. The org_members RLS forbids a user writing another
 * member's row, so these use the service-role client with an explicit admin
 * check. An admin may promote a member to 'super_admin' (an additional
 * master-key holder). The last-privileged-user DB trigger is the atomic backstop
 * (an org can never be left with zero super_admins or zero admins-or-above).
 */
export async function changeRoleAction(userId: string, role: string): Promise<ActionResult> {
  if (role !== 'manager' && role !== 'member' && role !== 'super_admin') {
    return { ok: false, error: 'invalid_role' };
  }
  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  // Capture the old role for the audit trail (U5). Org-scoped read.
  const { data: prior } = await service
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const oldRole = (prior?.role as string | undefined) ?? null;

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

  revalidatePath('/members');
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
  revalidatePath('/members');
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
  revalidatePath('/members');
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
