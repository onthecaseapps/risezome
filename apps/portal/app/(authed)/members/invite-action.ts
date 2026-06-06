'use server';

import { randomBytes } from 'node:crypto';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireManager } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Mint a shareable invite link (manager-only). The token row is the source of
 * truth for the role + bot-invite the link grants — never trusted from input
 * at accept time. Mirrors the pending_installations CSRF-token discipline:
 * unguessable token, explicit expiry (table default 7 days), redeemed-and-
 * deleted on accept.
 */
export async function createInviteAction(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { orgId, user } = await requireManager();

  const roleRaw = formData.get('role');
  const role = roleRaw === 'manager' ? 'manager' : 'member';
  const canInviteBot = formData.get('can_invite_bot') === 'true';
  const nameRaw = formData.get('name');
  // The recipient label so a manager can tell which pending link is whose.
  // Optional, trimmed, capped; null when blank.
  const name =
    typeof nameRaw === 'string' && nameRaw.trim().length > 0 ? nameRaw.trim().slice(0, 80) : null;

  // Optional target team: the new member is added to it on accept. Validated
  // server-side (must be a live, non-archived team in THIS org) — never trust the
  // client's id blindly, even though only an admin can reach this action. Blank /
  // 'all' / unknown ⇒ null (no team assignment), same default as no picker.
  const teamIdRaw = formData.get('team_id');
  const requestedTeamId =
    typeof teamIdRaw === 'string' && teamIdRaw.length > 0 && teamIdRaw !== 'all'
      ? teamIdRaw
      : null;

  const token = randomBytes(32).toString('hex');
  const service = createServiceRoleClient();

  let teamId: string | null = null;
  if (requestedTeamId !== null) {
    const { data: team } = await service
      .from('teams')
      .select('team_id')
      .eq('team_id', requestedTeamId)
      .eq('org_id', orgId)
      .is('archived_at', null)
      .maybeSingle();
    teamId = team !== null ? requestedTeamId : null;
  }

  const { error } = await service.from('org_invites').insert({
    token,
    org_id: orgId,
    role,
    can_invite_bot: canInviteBot,
    created_by: user.id,
    name,
    team_id: teamId,
  });
  if (error !== null) {
    return { ok: false, error: error.message };
  }

  const h = await headers();
  const host = h.get('host') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const url = `${proto}://${host}/invite/${token}`;

  revalidatePath('/teams');
  return { ok: true, url };
}

/**
 * Revoke a pending invite (manager-only). Scoped to the manager's own org so a
 * token from another org can't be deleted by guessing it.
 */
export async function revokeInviteAction(
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('org_invites')
    .delete()
    .eq('token', token)
    .eq('org_id', orgId);
  if (error !== null) {
    return { ok: false, error: error.message };
  }
  revalidatePath('/teams');
  return { ok: true };
}
