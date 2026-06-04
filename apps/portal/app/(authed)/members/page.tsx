import { type ReactElement } from 'react';
import { requireManager } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { MembersClient, type MemberRow, type PendingInvite } from './_member-list';

/**
 * Manager-only member management. requireManager() redirects non-managers.
 *
 * The org_members roster read goes through the RLS-scoped authed client
 * (createServerClient): the "read own membership or all as admin" SELECT
 * policy returns every org member because this page is requireManager()-gated
 * (an alias of requireAdmin), so is_org_admin(org_id) holds for the caller. RLS
 * is the second layer.
 *
 * Two reads MUST stay on service-role (U5 exceptions):
 *   - auth.users display names / last-active (admin getUserById): the admin
 *     auth API cannot run under RLS.
 *   - org_invites: that table has RLS enabled with NO authenticated SELECT
 *     policy, so the authed client reads 0 rows; the manager gate makes the
 *     service-role read safe.
 * Invite "invited by" names are resolved from the membership list (the inviter
 * is almost always a current member); unknown inviters fall back to null.
 */
export default async function MembersPage(): Promise<ReactElement> {
  const { orgId, orgName, user } = await requireManager();
  const supabase = await createServerClient();
  const service = createServiceRoleClient();

  const { data: memberRows } = await supabase
    .from('org_members')
    .select('user_id, role, can_invite_bot, joined_at')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true });

  const members: MemberRow[] = [];
  const nameByUserId = new Map<string, string>();
  for (const row of memberRows ?? []) {
    const userId = row.user_id as string;
    const { data: u } = await service.auth.admin.getUserById(userId);
    const email = u?.user?.email ?? userId;
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : null;
    nameByUserId.set(userId, name ?? email);
    members.push({
      userId,
      email,
      name,
      role: row.role as string,
      canInviteBot: row.can_invite_bot as boolean,
      isSelf: userId === user.id,
      lastSignInAt: u?.user?.last_sign_in_at ?? null,
    });
  }

  const { data: inviteRows } = await service
    .from('org_invites')
    .select('token, role, can_invite_bot, expires_at, created_at, created_by, name')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  const invites: PendingInvite[] = (inviteRows ?? []).map((r) => ({
    token: r.token as string,
    role: r.role as string,
    canInviteBot: r.can_invite_bot as boolean,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
    invitedByName: nameByUserId.get(r.created_by as string) ?? null,
    name: (r.name as string | null) ?? null,
  }));

  return <MembersClient members={members} invites={invites} orgName={orgName} />;
}
