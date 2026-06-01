import { type ReactElement } from 'react';
import { requireManager } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { MemberList, type MemberRow, type PendingInvite } from './_member-list';

/**
 * Manager-only member management. requireManager() redirects non-managers.
 * Reads membership + pending invites via the service-role client (a manager
 * reading other members would otherwise need the SECURITY DEFINER reader; the
 * explicit requireManager gate makes the service-role read safe here).
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
  for (const row of memberRows ?? []) {
    const userId = row.user_id as string;
    const { data: u } = await service.auth.admin.getUserById(userId);
    const email = u?.user?.email ?? userId;
    const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : null;
    members.push({
      userId,
      email,
      name,
      role: row.role as string,
      canInviteBot: row.can_invite_bot as boolean,
      isSelf: userId === user.id,
    });
  }

  const { data: inviteRows } = await service
    .from('org_invites')
    .select('token, role, can_invite_bot, expires_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  const invites: PendingInvite[] = (inviteRows ?? []).map((r) => ({
    token: r.token as string,
    role: r.role as string,
    canInviteBot: r.can_invite_bot as boolean,
    expiresAt: r.expires_at as string,
  }));

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
        <p className="mt-1.5 text-sm text-muted">
          Manage who can access <span className="text-fg">{orgName}</span> and what they can do.
        </p>
      </header>
      <MemberList members={members} invites={invites} />
    </div>
  );
}
