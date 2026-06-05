import type { ReactElement } from 'react';
import { requireAdmin } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { TeamsClient, type OrgMember, type TeamRow, type TeamSourceRow } from './_components/teams-client';

/**
 * Teams management (teams restructure U7). Manager/super_admin only —
 * requireAdmin() redirects members away.
 *
 * Read model (org-scoped):
 *   - teams: non-archived teams in the org, with member + selected-source counts.
 *   - team_members: every (team_id, user_id) join in the org, to drive the
 *     per-team member editor + counts.
 *   - team_sources: every (team_id, source_id) join, to mark which sources each
 *     team has selected.
 *   - sources: the org's selectable sources (status != 'removed'), the pool the
 *     per-team source picker toggles against.
 *   - org_members + auth display names: the roster the member picker adds from.
 *
 * Reads use the RLS-scoped authed client where a policy exists (this page is
 * requireAdmin-gated so is_org_admin holds); auth display names need the admin
 * API, which only the service-role client can call (same exception as
 * members/page.tsx).
 */
export default async function TeamsPage(): Promise<ReactElement> {
  const { orgId, orgName, user } = await requireAdmin();
  const supabase = await createServerClient();
  const service = createServiceRoleClient();

  const { data: teamRows } = await supabase
    .from('teams')
    .select('team_id, name, slug, created_at')
    .eq('org_id', orgId)
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  const teamIds = (teamRows ?? []).map((t) => t.team_id as string);

  // Membership + source joins for all of the org's teams in two reads.
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
  for (const j of sourceJoins ?? []) {
    const list = sourcesByTeam.get(j.team_id as string) ?? [];
    list.push(j.source_id as string);
    sourcesByTeam.set(j.team_id as string, list);
  }

  // The org's selectable sources (the curation pool). Hide already-de-indexed rows.
  const { data: srcRows } = await supabase
    .from('sources')
    .select('id, kind, display_name, repo_full_name, external_id')
    .eq('org_id', orgId)
    .neq('status', 'removed')
    .order('kind', { ascending: true });

  const sources: TeamSourceRow[] = (srcRows ?? []).map((s) => ({
    id: s.id as string,
    kind: (s.kind as string | null) ?? 'github',
    label: sourceLabel(s),
  }));

  // Org roster (with display names) — the member-picker pool.
  const { data: orgMemberRows } = await supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .order('joined_at', { ascending: true });

  const members: OrgMember[] = [];
  for (const row of orgMemberRows ?? []) {
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
      isSelf: userId === user.id,
    });
  }

  const teams: TeamRow[] = (teamRows ?? []).map((t) => ({
    teamId: t.team_id as string,
    name: t.name as string,
    slug: t.slug as string,
    memberIds: membersByTeam.get(t.team_id as string) ?? [],
    sourceIds: sourcesByTeam.get(t.team_id as string) ?? [],
  }));

  return (
    <TeamsClient orgName={orgName} teams={teams} members={members} sources={sources} />
  );
}

/** Human label for a source row across kinds (github repo / trello board / jira /
 *  confluence). Falls back to the external id, then the row id. */
function sourceLabel(s: Record<string, unknown>): string {
  const repo = s['repo_full_name'];
  if (typeof repo === 'string' && repo.length > 0) return repo;
  const display = s['display_name'];
  if (typeof display === 'string' && display.length > 0) return display;
  const ext = s['external_id'];
  if (typeof ext === 'string' && ext.length > 0) return ext;
  return s['id'] as string;
}
