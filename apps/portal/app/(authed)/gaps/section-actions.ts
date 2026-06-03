'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { requireManager } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';

/**
 * Section curation + manual gap merge (plan U11). ALL actions are MANAGER ONLY
 * (requireManager redirects non-managers; the actions also run via the service
 * role behind that gate). Every structural edit sets the curation pins
 * (name_locked / section_pinned) so the assembly re-clusterer never overrides
 * manual curation (KTD6 / AE3).
 */

type ActionResult = { ok: true } | { ok: false; error: string };

const SECTION_COLORS = ['indigo', 'emerald', 'sky', 'amber', 'rose', 'violet', 'teal', 'slate'];

function pickColor(): string {
  return SECTION_COLORS[Math.floor(Math.random() * SECTION_COLORS.length)] ?? 'slate';
}

/** Rename a section (sets name_locked so re-cluster never renames it). */
export async function renameSectionAction(sectionId: string, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty_name' };
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('knowledge_gap_sections')
    .update({ name: trimmed, name_locked: true })
    .eq('section_id', sectionId)
    .eq('org_id', orgId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/** Re-point all gaps from `sourceId` into `targetId`, then delete the source. */
export async function mergeSectionAction(sourceId: string, targetId: string): Promise<ActionResult> {
  if (sourceId === targetId) return { ok: false, error: 'same_section' };
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const { error: moveErr } = await service
    .from('knowledge_gaps')
    .update({ section_id: targetId, section_pinned: true })
    .eq('org_id', orgId)
    .eq('section_id', sourceId);
  if (moveErr !== null) return { ok: false, error: moveErr.message };
  // Lock the surviving target so re-cluster can't restructure the merged group.
  const { error: lockErr } = await service
    .from('knowledge_gap_sections')
    .update({ name_locked: true })
    .eq('section_id', targetId)
    .eq('org_id', orgId);
  if (lockErr !== null) return { ok: false, error: lockErr.message };
  const { error: delErr } = await service
    .from('knowledge_gap_sections')
    .delete()
    .eq('section_id', sourceId)
    .eq('org_id', orgId);
  if (delErr !== null) return { ok: false, error: delErr.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/** Create a new section and move the given gaps into it (name_locked). */
export async function splitSectionAction(name: string, gapIds: string[]): Promise<ActionResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty_name' };
  if (gapIds.length === 0) return { ok: false, error: 'no_gaps' };
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const sectionId = `sec_${randomUUID()}`;
  const { error: insErr } = await service.from('knowledge_gap_sections').insert({
    section_id: sectionId,
    org_id: orgId,
    name: trimmed,
    color: pickColor(),
    name_locked: true,
  });
  if (insErr !== null) return { ok: false, error: insErr.message };
  const { error: moveErr } = await service
    .from('knowledge_gaps')
    .update({ section_id: sectionId, section_pinned: true })
    .eq('org_id', orgId)
    .in('gap_id', gapIds);
  if (moveErr !== null) return { ok: false, error: moveErr.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/** Move every gap in a section to another section (or Uncategorized → null). */
export async function moveAllGapsAction(sourceId: string, targetId: string | null): Promise<ActionResult> {
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('knowledge_gaps')
    .update({ section_id: targetId, section_pinned: true })
    .eq('org_id', orgId)
    .eq('section_id', sourceId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/**
 * Delete a section. Only succeeds if it has no gaps; if it still has gaps the
 * caller must move them first (pass `reassignTo` to move-then-delete in one go).
 */
export async function deleteSectionAction(sectionId: string, reassignTo: string | null): Promise<ActionResult> {
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();

  const { count } = await service
    .from('knowledge_gaps')
    .select('gap_id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('section_id', sectionId);
  const gapCount = count ?? 0;

  if (gapCount > 0) {
    if (reassignTo === undefined) return { ok: false, error: 'section_not_empty' };
    const { error: moveErr } = await service
      .from('knowledge_gaps')
      .update({ section_id: reassignTo, section_pinned: true })
      .eq('org_id', orgId)
      .eq('section_id', sectionId);
    if (moveErr !== null) return { ok: false, error: moveErr.message };
  }

  const { error } = await service
    .from('knowledge_gap_sections')
    .delete()
    .eq('section_id', sectionId)
    .eq('org_id', orgId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/**
 * Move one gap into a section (or Uncategorized → null). Sets section_pinned so
 * re-cluster never moves it back (KTD6 / AE3).
 */
export async function moveGapToSectionAction(gapId: string, sectionId: string | null): Promise<ActionResult> {
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();
  const { error } = await service
    .from('knowledge_gaps')
    .update({ section_id: sectionId, section_pinned: true })
    .eq('org_id', orgId)
    .eq('gap_id', gapId);
  if (error !== null) return { ok: false, error: error.message };
  revalidatePath('/gaps');
  return { ok: true };
}

/** Create a new section and move a single gap into it. */
export async function createSectionForGapAction(name: string, gapId: string): Promise<ActionResult> {
  return splitSectionAction(name, [gapId]);
}

/**
 * Manually merge gap B into gap A (mockup #10). Re-points B's occurrences to A
 * (on the (meeting_id, utterance_id) unique conflict, B's duplicate occurrence
 * is dropped), unions viewers, recomputes A.frequency from its occurrences, and
 * deletes B. Irreversible. MANAGER ONLY.
 */
export async function mergeGapsAction(targetGapId: string, sourceGapId: string): Promise<ActionResult> {
  if (targetGapId === sourceGapId) return { ok: false, error: 'same_gap' };
  const { orgId } = await requireManager();
  const service = createServiceRoleClient();

  // Both gaps must belong to the manager's org.
  const { data: pair, error: loadErr } = await service
    .from('knowledge_gaps')
    .select('gap_id, org_id')
    .in('gap_id', [targetGapId, sourceGapId])
    .eq('org_id', orgId);
  if (loadErr !== null) return { ok: false, error: loadErr.message };
  if ((pair ?? []).length !== 2) return { ok: false, error: 'not_found' };

  // Re-point B's occurrences to A. Handle the unique (meeting_id, utterance_id)
  // conflict by dropping B's duplicate: find A's existing (meeting,utterance)
  // keys and delete colliding B occurrences before the bulk re-point.
  const { data: aOcc } = await service
    .from('gap_occurrences')
    .select('meeting_id, utterance_id')
    .eq('gap_id', targetGapId);
  const aKeys = new Set((aOcc ?? []).map((o) => `${o.meeting_id as string}:${(o.utterance_id as string | null) ?? ''}`));

  const { data: bOcc } = await service
    .from('gap_occurrences')
    .select('occurrence_id, meeting_id, utterance_id')
    .eq('gap_id', sourceGapId);
  const collidingIds: number[] = [];
  for (const o of bOcc ?? []) {
    const key = `${o.meeting_id as string}:${(o.utterance_id as string | null) ?? ''}`;
    if (aKeys.has(key)) collidingIds.push(o.occurrence_id as number);
  }
  if (collidingIds.length > 0) {
    const { error: dropErr } = await service.from('gap_occurrences').delete().in('occurrence_id', collidingIds);
    if (dropErr !== null) return { ok: false, error: dropErr.message };
  }
  const { error: repointErr } = await service
    .from('gap_occurrences')
    .update({ gap_id: targetGapId })
    .eq('gap_id', sourceGapId);
  if (repointErr !== null) return { ok: false, error: repointErr.message };

  // Union viewers from B into A (on conflict do nothing).
  const { data: bViewers } = await service.from('gap_viewers').select('user_id, org_id').eq('gap_id', sourceGapId);
  if ((bViewers ?? []).length > 0) {
    const rows = (bViewers ?? []).map((v) => ({
      gap_id: targetGapId,
      user_id: v.user_id as string,
      org_id: v.org_id as string,
    }));
    const { error: viewErr } = await service
      .from('gap_viewers')
      .upsert(rows, { onConflict: 'gap_id,user_id', ignoreDuplicates: true });
    if (viewErr !== null) return { ok: false, error: viewErr.message };
  }

  // Recompute A's frequency + ask-window from its (now combined) occurrences —
  // B may have carried an earlier first ask or a later last ask.
  const { count: freq } = await service
    .from('gap_occurrences')
    .select('occurrence_id', { count: 'exact', head: true })
    .eq('gap_id', targetGapId);
  const { data: span } = await service
    .from('gap_occurrences')
    .select('asked_at')
    .eq('gap_id', targetGapId)
    .order('asked_at', { ascending: true });
  const askedAts = (span ?? []).map((o) => o.asked_at as string);
  const update: Record<string, unknown> = { frequency: freq ?? 0 };
  if (askedAts.length > 0) {
    update['first_asked_at'] = askedAts[0];
    update['last_asked_at'] = askedAts[askedAts.length - 1];
  }
  const { error: freqErr } = await service
    .from('knowledge_gaps')
    .update(update)
    .eq('gap_id', targetGapId);
  if (freqErr !== null) return { ok: false, error: freqErr.message };

  // Delete B (its remaining occurrences were re-pointed; viewers cascade).
  const { error: delErr } = await service.from('knowledge_gaps').delete().eq('gap_id', sourceGapId).eq('org_id', orgId);
  if (delErr !== null) return { ok: false, error: delErr.message };

  revalidatePath('/gaps');
  return { ok: true };
}
