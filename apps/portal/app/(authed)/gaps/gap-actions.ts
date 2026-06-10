'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg, requireManager } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { isAdminRole } from '../../_lib/roles';
import { inngest } from '../../../src/inngest/client';
import type { GapOccurrenceView } from './_types';

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
  role: 'member' | 'manager' | 'super_admin';
}

/** Load a gap (service role) and resolve the caller's permission against it. */
async function loadGapForActor(
  gapId: string,
): Promise<
  | {
      ok: true;
      ctx: GapPermCtx;
      gap: { status: string; assignee_id: string | null; org_id: string; shared_with_org: boolean };
    }
  | { ok: false; error: string }
> {
  const { orgId, user, role } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();
  const { data, error } = await service
    .from('knowledge_gaps')
    .select('status, assignee_id, org_id, shared_with_org')
    .eq('gap_id', gapId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error !== null) return { ok: false, error: error.message };
  if (data === null) return { ok: false, error: 'not_found' };
  return {
    ok: true,
    // Admin power = manager OR super_admin (KTD2) — super_admin inherits all
    // admin abilities, so it must not be locked out of resolve/dismiss/share.
    ctx: { orgId, userId: user.id, isManager: isAdminRole(role), role },
    gap: {
      status: data.status as string,
      assignee_id: (data.assignee_id as string | null) ?? null,
      org_id: data.org_id as string,
      shared_with_org: (data.shared_with_org as boolean | null) ?? false,
    },
  };
}

/** Can the caller SEE this gap (and therefore assign a question from it)? Mirrors
 *  can_view_gap (U5): super-admin master key, org-wide share, or a participant-
 *  seeded gap viewer. Resolved via the service role for the server action. */
async function callerCanViewGap(
  service: ReturnType<typeof createServiceRoleClient>,
  ctx: GapPermCtx,
  gap: { shared_with_org: boolean },
  gapId: string,
): Promise<boolean> {
  if (ctx.role === 'super_admin') return true;
  if (gap.shared_with_org) return true;
  const { data } = await service
    .from('gap_viewers')
    .select('user_id')
    .eq('gap_id', gapId)
    .eq('user_id', ctx.userId)
    .maybeSingle();
  return data !== null;
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
 * Assign a gap's question to ANYONE in the org (teams restructure U5; R8/AE3).
 *
 * Gating: the caller must be able to SEE the gap (attendee / org-share / master
 * key) — you can only assign a question you can see. The TARGET may be any org
 * member. Assignment is METADATA-ONLY: it sets assignee_id but does NOT seed
 * gap_viewers, so a non-attendee assignee gains NO verbatim — they see only the
 * question, asker, and metrics via list_assigned_questions (KTD6). Reopens a
 * closed gap, notifies the assignee, and writes a gap_assignment audit row (R10).
 */
export async function assignGapAction(gapId: string, assigneeUserId: string): Promise<ActionResult> {
  const loaded = await loadGapForActor(gapId);
  if (!loaded.ok) return loaded;
  const { ctx, gap } = loaded;

  const service = createServiceRoleClient();

  // The caller must be entitled to the gap to assign a question from it.
  if (!(await callerCanViewGap(service, ctx, gap, gapId))) {
    return { ok: false, error: 'forbidden' };
  }

  // The assignee must be a member of this org ("anyone in the org", R8) — not an
  // arbitrary cross-org UUID.
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

  // NOTE (KTD6): we deliberately do NOT seed gap_viewers here. Assignment is
  // metadata-only; the assignee reads the question/asker/metrics via
  // list_assigned_questions and never gains gap_occurrences verbatim.

  // R10: audit the assignment (append-only permission_audit_log).
  const { error: auditErr } = await service.from('permission_audit_log').insert({
    org_id: ctx.orgId,
    actor_id: ctx.userId,
    action: 'gap_assignment',
    detail: { gap_id: gapId, assignee_id: assigneeUserId },
  });
  if (auditErr !== null) {
    console.warn(`[gaps] assignment audit failed (gap=${gapId}): ${auditErr.message}`);
  }

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
 * Lazily load one gap's occurrences for the drawer (moments + merged phrasings).
 *
 * The gaps page no longer bulk-fetches every occurrence for every gap (that was
 * an unbounded transfer that grew with org age and a big part of the page-switch
 * latency); the drawer calls this when a gap is opened. Reads go through the
 * RLS-scoped AUTHED client, so the can_view_gap_content gate enforces itself —
 * a non-content viewer (outsider-assignee / org-share) gets [] back, never the
 * room's verbatim.
 */
export async function listGapOccurrencesAction(
  gapId: string,
): Promise<{ ok: true; occurrences: GapOccurrenceView[] } | { ok: false; error: string }> {
  await requireAuthedUserWithOrg();
  const supabase = await createServerClient();
  const { data: occRows, error } = await supabase
    .from('gap_occurrences')
    .select('occurrence_id, gap_id, meeting_id, utterance_id, verbatim_question, asker_name, asker_user_id, asked_at')
    .eq('gap_id', gapId)
    .order('asked_at', { ascending: false })
    .limit(50);
  if (error !== null) {
    // Stable code, not the raw DB message (schema details don't belong client-side).
    console.error(`[gaps] occurrence load failed (gap=${gapId}):`, error.message);
    return { ok: false, error: 'occurrences_load_failed' };
  }

  const rows = occRows ?? [];
  const meetingIds = [...new Set(rows.map((r) => r.meeting_id as string))];
  const titleByMeeting = new Map<string, string>();
  if (meetingIds.length > 0) {
    const { data: meetingRows } = await supabase
      .from('meetings')
      .select('meeting_id, title')
      .in('meeting_id', meetingIds);
    for (const m of meetingRows ?? []) {
      titleByMeeting.set(m.meeting_id as string, (m.title as string) ?? '');
    }
  }

  return {
    ok: true,
    occurrences: rows.map((r) => ({
      occurrenceId: String(r.occurrence_id),
      meetingId: r.meeting_id as string,
      utteranceId: (r.utterance_id as string | null) ?? null,
      verbatimQuestion: r.verbatim_question as string,
      askerName: r.asker_name as string,
      askerUserId: (r.asker_user_id as string | null) ?? null,
      askedAtIso: r.asked_at as string,
      meetingTitle: titleByMeeting.get(r.meeting_id as string) ?? '',
    })),
  };
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
