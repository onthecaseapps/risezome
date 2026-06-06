import type { ReactElement } from 'react';
import { requireAdmin } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import {
  TeamsMembersClient,
  type MemberVM,
  type PendingInviteVM,
  type TeamVM,
} from './_components/teams-members-client';

/**
 * Unified "Teams & members" surface (teams + members consolidation). Replaces the
 * separate /members and /teams pages — /members now redirects here. Manager/
 * super_admin only; requireAdmin() redirects members away.
 *
 * One server read assembles every view model the client rail needs:
 *   - members: org_members + auth display names / last-active (the All-members
 *     roster). Same pattern + same service-role exception as the old members/page.
 *   - teams + team_members + team_sources: drives the rail counts, the per-member
 *     team pills, and each team's detail (member list + selected sources).
 *   - sources: the org's selectable sources (status != 'removed') — the pool the
 *     per-team source toggles act on (reused from the old teams/page).
 *   - org_invites: pending invites (service-role exception: that table has RLS
 *     enabled with no authenticated SELECT policy; the admin gate makes it safe).
 *
 * RLS-scoped authed client where a policy exists (this page is requireAdmin-gated
 * so is_org_admin holds); the two reads that MUST stay on service-role are the
 * auth admin API (display names / last-active) and org_invites — same U5
 * exceptions documented in the prior members/teams pages.
 */
export default async function TeamsMembersPage(): Promise<ReactElement> {
  const { orgId, orgName, user, role: callerRole } = await requireAdmin();
  const supabase = await createServerClient();
  const service = createServiceRoleClient();

  // ── Teams + their member/source joins ─────────────────────────────────────
  const { data: teamRows } = await supabase
    .from('teams')
    .select('team_id, name, slug, created_at')
    .eq('org_id', orgId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  const teamIds = (teamRows ?? []).map((t) => t.team_id as string);

  const { data: memberJoins } = teamIds.length
    ? await supabase.from('team_members').select('team_id, user_id').in('team_id', teamIds)
    : { data: [] as { team_id: string; user_id: string }[] };

  const { data: sourceJoins } = teamIds.length
    ? await supabase.from('team_sources').select('team_id, source_id').in('team_id', teamIds)
    : { data: [] as { team_id: string; source_id: string }[] };

  const membersByTeam = new Map<string, string[]>();
  for (const j of memberJoins ?? []) {
    const list = membersByTeam.get(j.team_id as string) ?? [];
    list.push(j.user_id as string);
    membersByTeam.set(j.team_id as string, list);
  }
  const sourcesByTeam = new Map<string, string[]>();
  const teamsByUser = new Map<string, string[]>();
  for (const j of memberJoins ?? []) {
    const list = teamsByUser.get(j.user_id as string) ?? [];
    list.push(j.team_id as string);
    teamsByUser.set(j.user_id as string, list);
  }
  for (const j of sourceJoins ?? []) {
    const list = sourcesByTeam.get(j.team_id as string) ?? [];
    list.push(j.source_id as string);
    sourcesByTeam.set(j.team_id as string, list);
  }

  const teams: TeamVM[] = (teamRows ?? []).map((t) => ({
    teamId: t.team_id as string,
    name: t.name as string,
    slug: t.slug as string,
    memberIds: membersByTeam.get(t.team_id as string) ?? [],
    sourceIds: sourcesByTeam.get(t.team_id as string) ?? [],
  }));

  // ── Org roster + auth display names / last-active ─────────────────────────
  const { data: memberRows } = await supabase
    .from('org_members')
    .select('user_id, role, can_invite_bot, joined_at')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true });

  const members: MemberVM[] = [];
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
      teamIds: teamsByUser.get(userId) ?? [],
    });
  }

  // ── Pending invites ───────────────────────────────────────────────────────
  const { data: inviteRows } = await service
    .from('org_invites')
    .select('token, role, can_invite_bot, expires_at, created_at, created_by, name, team_id')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  const invites: PendingInviteVM[] = (inviteRows ?? []).map((r) => ({
    token: r.token as string,
    role: r.role as string,
    canInviteBot: r.can_invite_bot as boolean,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
    invitedByName: nameByUserId.get(r.created_by as string) ?? null,
    name: (r.name as string | null) ?? null,
    teamId: (r.team_id as string | null) ?? null,
  }));

  return (
    <TeamsMembersClient
      orgName={orgName}
      members={members}
      teams={teams}
      invites={invites}
      isSuperAdmin={callerRole === 'super_admin'}
    />
  );
}
