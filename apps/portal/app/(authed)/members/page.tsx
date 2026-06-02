import { type ReactElement } from 'react';
import { requireManager } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { MembersClient, type MemberRow, type PendingInvite } from './_member-list';

/**
 * Manager-only member management. requireManager() redirects non-managers.
 * Reads membership + pending invites via the service-role client (a manager
 * reading other members would otherwise need the SECURITY DEFINER reader; the
 * explicit requireManager gate makes the service-role read safe here).
 *
 * Last-active comes from auth.users.last_sign_in_at (already reachable via the
 * admin getUserById call we make per member). Invite "invited by" names are
 * resolved from the membership list (the inviter is almost always a current
 * member); unknown inviters fall back to null.
 */
export default async function MembersPage(): Promise<ReactElement> {
  const { orgId, orgName, user } = await requireManager();
  const service = createServiceRoleClient();

  const { data: memberRows } = await service
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
