'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../../_lib/auth';
import { createServiceRoleClient } from '../../../_lib/supabase-server';
import {
  isDuplicateSlugError,
  validateTeamName,
  validateTeamSlug,
} from './_lib/team-validation';

/**
 * Team management actions (teams restructure U7; KTD8).
 *
 * Mirrors members/member-actions.ts: every action is requireAdmin-gated (manager
 * OR super_admin), uses the service-role client (teams/team_members have NO client
 * write policy — RLS is read-only, writes go through here), is org_id-scoped as
 * defense-in-depth, audits to permission_audit_log, and revalidates /teams.
 *
 * Audit best-effort: the row already committed when we append the audit log, so a
 * failed audit insert must NOT surface as a failed action — log and continue,
 * exactly like member-actions.ts's role_change audit.
 */

type ActionResult = { ok: true } | { ok: false; error: string };
type CreateResult = { ok: true; teamId: string } | { ok: false; error: string };

/** Append a team audit row (best-effort). */
async function audit(
  service: ReturnType<typeof createServiceRoleClient>,
  args: {
    orgId: string;
    actorId: string;
    action: 'team_change' | 'team_membership_change';
    detail: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await service.from('permission_audit_log').insert({
    org_id: args.orgId,
    actor_id: args.actorId,
    action: args.action,
    target_meeting_id: null,
    detail: args.detail,
  });
  if (error !== null) {
    console.error(`[team-actions] ${args.action} audit insert failed:`, error.message);
  }
}

/**
 * Create a team. Validates name + slug (kebab, derived from the name when the
 * slug field is blank). The unique(org_id, slug) violation surfaces as the
 * friendly 'duplicate_slug' so the form can prompt for a different slug.
 */
export async function createTeamAction(name: string, slug: string): Promise<CreateResult> {
  const nameCheck = validateTeamName(name);
  if (!nameCheck.ok) return nameCheck;
  const slugCheck = validateTeamSlug(slug, nameCheck.value);
  if (!slugCheck.ok) return slugCheck;

  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  const { data: row, error } = await service
    .from('teams')
    .insert({ org_id: orgId, name: nameCheck.value, slug: slugCheck.value })
    .select('team_id')
    .single();
  if (error !== null || row === null) {
    if (error !== null && isDuplicateSlugError(error.message)) {
      return { ok: false, error: 'duplicate_slug' };
    }
    return { ok: false, error: error?.message ?? 'create_failed' };
  }

  const teamId = row.team_id as string;
  await audit(service, {
    orgId,
    actorId: user.id,
    action: 'team_change',
    detail: { action: 'create', team_id: teamId, name: nameCheck.value },
  });

  revalidatePath('/settings/teams');
  return { ok: true, teamId };
}

/** Rename a team. Org-scoped so an admin can't rename another org's team. */
export async function renameTeamAction(teamId: string, name: string): Promise<ActionResult> {
  const nameCheck = validateTeamName(name);
  if (!nameCheck.ok) return nameCheck;

  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  const { error } = await service
    .from('teams')
    .update({ name: nameCheck.value })
    .eq('team_id', teamId)
    .eq('org_id', orgId);
  if (error !== null) return { ok: false, error: error.message };

  await audit(service, {
    orgId,
    actorId: user.id,
    action: 'team_change',
    detail: { action: 'rename', team_id: teamId, name: nameCheck.value },
  });

  revalidatePath('/settings/teams');
  return { ok: true };
}

/** Soft-archive a team (archived_at = now). Archived teams drop out of switchers
 *  and contribute no sources; nothing is hard-deleted. */
export async function archiveTeamAction(teamId: string): Promise<ActionResult> {
  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  const { error } = await service
    .from('teams')
    .update({ archived_at: new Date().toISOString() })
    .eq('team_id', teamId)
    .eq('org_id', orgId)
    .is('archived_at', null);
  if (error !== null) return { ok: false, error: error.message };

  await audit(service, {
    orgId,
    actorId: user.id,
    action: 'team_change',
    detail: { action: 'archive', team_id: teamId },
  });

  revalidatePath('/settings/teams');
  return { ok: true };
}

/**
 * Add an org member to a team. Validates the target is actually a member of the
 * caller's org (defense-in-depth: service-role bypasses RLS, so we never trust
 * the userId blindly) before inserting the team_members row. Idempotent on the
 * (team_id, user_id) PK.
 */
export async function addTeamMemberAction(teamId: string, userId: string): Promise<ActionResult> {
  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  // The team must belong to this org, and the user must be a member of it.
  const { data: team } = await service
    .from('teams')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (team === null) return { ok: false, error: 'team_not_found' };

  const { data: membership } = await service
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (membership === null) return { ok: false, error: 'not_an_org_member' };

  const { error } = await service
    .from('team_members')
    .upsert({ team_id: teamId, user_id: userId }, { onConflict: 'team_id,user_id', ignoreDuplicates: true });
  if (error !== null) return { ok: false, error: error.message };

  await audit(service, {
    orgId,
    actorId: user.id,
    action: 'team_membership_change',
    detail: { action: 'add', team_id: teamId, user_id: userId },
  });

  revalidatePath('/settings/teams');
  return { ok: true };
}

/** Remove a member from a team. Org-scoped via the team lookup. */
export async function removeTeamMemberAction(teamId: string, userId: string): Promise<ActionResult> {
  const { user, orgId } = await requireAdmin();
  const service = createServiceRoleClient();

  const { data: team } = await service
    .from('teams')
    .select('team_id')
    .eq('team_id', teamId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (team === null) return { ok: false, error: 'team_not_found' };

  const { error } = await service
    .from('team_members')
    .delete()
    .eq('team_id', teamId)
    .eq('user_id', userId);
  if (error !== null) return { ok: false, error: error.message };

  await audit(service, {
    orgId,
    actorId: user.id,
    action: 'team_membership_change',
    detail: { action: 'remove', team_id: teamId, user_id: userId },
  });

  revalidatePath('/settings/teams');
  return { ok: true };
}
