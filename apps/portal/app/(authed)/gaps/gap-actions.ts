'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Gap lifecycle + assignment + sharing actions (plan U10).
 *
 * resolve/dismiss are allowed for a MANAGER or the gap's ASSIGNEE (we load the
 * gap via the service role and check the permission ourselves rather than
 * redirecting, so a non-manager assignee isn't bounced). assign/share are
 * MANAGER ONLY. All return { ok } and revalidate /gaps for optimistic-UI
 * rollback in the drawer.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

interface GapPermCtx {
  orgId: string;
  userId: string;
  isManager: boolean;
}

/** Load a gap (service role) and resolve the caller's permission against it. */
async function loadGapForActor(
  gapId: string,
): Promise<
  | { ok: true; ctx: GapPermCtx; gap: { status: string; assignee_id: string | null; org_id: string } }
  | { ok: false; error: string }
> {
  const { orgId, user, role } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();
  const { data, error } = await service
    .from('knowledge_gaps')
    .select('status, assignee_id, org_id')
    .eq('gap_id', gapId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error !== null) return { ok: false, error: error.message };
  if (data === null) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    ctx: { orgId, userId: user.id, isManager: role === 'manager' },
    gap: {
      status: data.status as string,
      assignee_id: (data.assignee_id as string | null) ?? null,
      org_id: data.org_id as string,
    },
  };
}

export async function resolveGapAction(gapId: string): Promise<ActionResult> {
  const loaded = await loadGapForActor(gapId);
  if (!loaded.ok) return loaded;
  const { ctx, gap } = loaded;
  if (!ctx.isManager && gap.assignee_id !== ctx.userId) return { ok: false, error: 'forbidden' };
  const service = createServiceRoleClient();
  const now = new Date().toISOString();
  const { error } = await service
    .from('knowledge_gaps')
    .update({ status: 'resolved', resolved_by: ctx.userId, resolved_at: now })
    .eq('gap_id', gapId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

export async function dismissGapAction(gapId: string): Promise<ActionResult> {
  const loaded = await loadGapForActor(gapId);
  if (!loaded.ok) return loaded;
  const { ctx, gap } = loaded;
  if (!ctx.isManager && gap.assignee_id !== ctx.userId) return { ok: false, error: 'forbidden' };
  const service = createServiceRoleClient();
  const now = new Date().toISOString();
  const { error } = await service
    .from('knowledge_gaps')
    .update({ status: 'dismissed', dismissed_by: ctx.userId, dismissed_at: now })
    .eq('gap_id', gapId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/**
 * Assign a gap to a member. MANAGER ONLY. Sets assignee + assigned_by/at;
 * reopens a closed gap; grants the assignee visibility by inserting them into
 * gap_viewers (KTD1); notifies them (R12).
 */
export async function assignGapAction(gapId: string, assigneeUserId: string): Promise<ActionResult> {
  const loaded = await loadGapForActor(gapId);
  if (!loaded.ok) return loaded;
  const { ctx, gap } = loaded;
  if (!ctx.isManager) return { ok: false, error: 'forbidden' };

  const service = createServiceRoleClient();
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    assignee_id: assigneeUserId,
    assigned_by: ctx.userId,
    assigned_at: now,
  };
  // Assigning forces a closed gap back to open (lifecycle).
  if (gap.status === 'resolved' || gap.status === 'dismissed') update['status'] = 'open';

  const { error: updErr } = await service.from('knowledge_gaps').update(update).eq('gap_id', gapId);
  if (updErr !== null) return { ok: false, error: updErr.message };

  // KTD1: the assignee gains visibility even if they weren't a participant.
  const { error: viewerErr } = await service
    .from('gap_viewers')
    .upsert({ gap_id: gapId, user_id: assigneeUserId, org_id: ctx.orgId }, { onConflict: 'gap_id,user_id', ignoreDuplicates: true });
  if (viewerErr !== null) return { ok: false, error: viewerErr.message };

  // R12: in-app notification. Don't notify a self-assignment.
  if (assigneeUserId !== ctx.userId) {
    await service.from('notifications').insert({
      user_id: assigneeUserId,
      org_id: ctx.orgId,
      type: 'gap_assigned',
      gap_id: gapId,
      actor_id: ctx.userId,
    });
  }

  revalidatePath('/gaps');
  return { ok: true };
}

/** Flip a gap to org-wide visibility. MANAGER ONLY (KTD1 "share with org"). */
export async function shareWithOrgAction(gapId: string): Promise<ActionResult> {
  const loaded = await loadGapForActor(gapId);
  if (!loaded.ok) return loaded;
  const { ctx } = loaded;
  if (!ctx.isManager) return { ok: false, error: 'forbidden' };
  const service = createServiceRoleClient();
  const { error } = await service.from('knowledge_gaps').update({ shared_with_org: true }).eq('gap_id', gapId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}
