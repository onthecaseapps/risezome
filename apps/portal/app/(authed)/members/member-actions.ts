'use server';

import { revalidatePath } from 'next/cache';
import { requireManager } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Change a member's role. Manager-only; scoped to the manager's org. The
 * org_members RLS forbids a user writing another member's row, so these use
 * the service-role client with an explicit manager check (requireManager).
 * The last-manager DB trigger is the atomic backstop for R11.
 */
export async function changeRoleAction(userId: string, role: string): Promise<ActionResult> {
  if (role !== 'manager' && role !== 'member') return { ok: false, error: 'invalid_role' };
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('org_members')
    .update({ role })
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error !== null) return { ok: false, error: lastManagerError(error.message) };
  revalidatePath('/members');
  return { ok: true };
}

/** Grant or revoke a member's "can invite the bot" permission. */
export async function setCanInviteBotAction(userId: string, value: boolean): Promise<ActionResult> {
  const { orgId } = await requireManager();
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
  const { orgId } = await requireManager();
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

/** Map the last-manager trigger's exception to a friendly code. */
function lastManagerError(message: string): string {
  if (message.includes('last manager')) return 'last_manager';
  return message;
}
