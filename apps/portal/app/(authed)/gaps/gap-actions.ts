'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg, requireManager } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { inngest } from '../../../src/inngest/client';

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
    .eq('gap_id', gapId)
    .eq('org_id', ctx.orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
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
    .eq('gap_id', gapId)
    .eq('org_id', ctx.orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
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

  // The assignee must be a member of this org — assignment grants gap_viewers
  // visibility, so assigning an arbitrary (cross-org) user UUID would leak the
  // gap to a non-member.
  const { data: membership } = await service
    .from('org_members')
    .select('user_id')
    .eq('org_id', ctx.orgId)
    .eq('user_id', assigneeUserId)
    .maybeSingle();
  if (membership === null) return { ok: false, error: 'not_a_member' };

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    assignee_id: assigneeUserId,
    assigned_by: ctx.userId,
    assigned_at: now,
  };
  // Assigning forces a closed gap back to open, clearing the stale closure stamp.
  if (gap.status === 'resolved' || gap.status === 'dismissed') {
    update['status'] = 'open';
    update['resolved_by'] = null;
    update['resolved_at'] = null;
    update['dismissed_by'] = null;
    update['dismissed_at'] = null;
  }

  const { error: updErr } = await service
    .from('knowledge_gaps')
    .update(update)
    .eq('gap_id', gapId)
    .eq('org_id', ctx.orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
  if (updErr !== null) return { ok: false, error: updErr.message };

  // KTD1: the assignee gains visibility even if they weren't a participant.
  const { error: viewerErr } = await service
    .from('gap_viewers')
    .upsert({ gap_id: gapId, user_id: assigneeUserId, org_id: ctx.orgId }, { onConflict: 'gap_id,user_id', ignoreDuplicates: true });
  if (viewerErr !== null) return { ok: false, error: viewerErr.message };

  // R12: in-app notification. Don't notify a self-assignment.
  if (assigneeUserId !== ctx.userId) {
    const { error: notifyErr } = await service.from('notifications').insert({
      user_id: assigneeUserId,
      org_id: ctx.orgId,
      type: 'gap_assigned',
      gap_id: gapId,
      actor_id: ctx.userId,
    });
    if (notifyErr !== null) {
      console.warn(`[gaps] assignment notification failed (gap=${gapId}): ${notifyErr.message}`);
    }
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
  const { error } = await service
    .from('knowledge_gaps')
    .update({ shared_with_org: true })
    .eq('gap_id', gapId)
    .eq('org_id', ctx.orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/**
 * Backfill the library from this org's already-ended meetings (MANAGER ONLY).
 * Fire-and-forget: enqueues the backfill Inngest job, which reconstructs misses
 * from past retracted syntheses and runs assembly per meeting.
 */
export async function requestGapsBackfillAction(): Promise<ActionResult> {
  const { orgId } = await requireManager();
  try {
    await inngest.send({ name: 'risezome/gaps.backfill-requested', data: { orgId } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'backfill enqueue failed' };
  }
  return { ok: true };
}
