'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CURRENT_ORG_COOKIE, requireAuthedUser } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Accept a workspace invite. Form action: reads the token, requires a signed-in
 * Google user, and materializes membership.
 *
 * Security invariants:
 *   - role + can_invite_bot are read ONLY from the org_invites row keyed by the
 *     token — never from the request, so an invitee can't self-upgrade.
 *   - idempotent no-op when already a member: an existing member's role/grant
 *     is NOT changed on re-accept (prevents privilege escalation via a manager
 *     link forwarded to an existing member).
 *   - the token is deleted after a successful (or already-member) accept —
 *     single-use, anti-replay.
 */
export async function acceptInviteAction(formData: FormData): Promise<void> {
  const tokenRaw = formData.get('token');
  const token = typeof tokenRaw === 'string' ? tokenRaw : '';
  if (token.length === 0) redirect('/');

  // Must be signed in to accept. (The preview page routes anonymous visitors
  // through Google sign-in with next=/invite/<token> first.)
  const user = await requireAuthedUser();
  const service = createServiceRoleClient();

  // service-role-cross-org: invite acceptance has no org in scope yet; the
  // unguessable single-use invite token IS the cross-org-safe key resolving org_id.
  const { data: invite, error: readErr } = await service
    .from('org_invites')
    .select('token, org_id, role, can_invite_bot, expires_at, team_id')
    .eq('token', token)
    .maybeSingle();
  if (readErr !== null) redirect(`/invite/${token}?error=lookup_failed`);
  if (invite === null) redirect(`/invite/${token}?error=invalid`);
  if (new Date(invite.expires_at as string) <= new Date()) {
    redirect(`/invite/${token}?error=expired`);
  }

  const orgId = invite.org_id as string;
  const role = invite.role as string;

  // No-op when already a member: do not clobber the existing role/grant.
  const { data: existing } = await service
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing === null) {
    const { error: insertErr } = await service.from('org_members').insert({
      org_id: orgId,
      user_id: user.id,
      role,
      can_invite_bot: invite.can_invite_bot as boolean,
    });
    if (insertErr !== null) redirect(`/invite/${token}?error=join_failed`);

    // Pre-assign the new member to the invite's team, if it carries one. Defensive:
    // the team may have been archived or deleted (ON DELETE SET NULL nulls the FK,
    // archive leaves it set) between mint and accept, so re-check it's live in this
    // org before inserting. Best-effort — a failed team assignment must NOT block the
    // join (they're already an org member); log and continue.
    const teamId = (invite.team_id as string | null) ?? null;
    if (teamId !== null) {
      const { data: team } = await service
        .from('teams')
        .select('team_id')
        .eq('team_id', teamId)
        .eq('org_id', orgId)
        .is('archived_at', null)
        .maybeSingle();
      if (team !== null) {
        const { error: teamErr } = await service
          .from('team_members')
          .upsert(
            { team_id: teamId, user_id: user.id },
            { onConflict: 'team_id,user_id', ignoreDuplicates: true },
          );
        if (teamErr !== null) {
          console.error('[accept-invite] team assignment failed:', teamErr.message);
        }
      }
    }
  }

  // Single-use: consume the token regardless of new-vs-existing membership.
  // service-role-cross-org: keyed by the same unguessable single-use invite token.
  await service.from('org_invites').delete().eq('token', token);

  const cookieStore = await cookies();
  cookieStore.set(CURRENT_ORG_COOKIE, orgId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect(role === 'manager' ? '/sources' : '/upcoming');
}
