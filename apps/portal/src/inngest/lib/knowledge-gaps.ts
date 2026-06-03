/**
 * Knowledge Gaps — post-meeting assembly (plan U6 / U7).
 *
 * Pure helpers (testable without a DB) + the orchestration that wires them to
 * Supabase. The orchestration:
 *   1. loads this meeting's unprocessed misses
 *   2. resolves each asker from the transcript (R2)
 *   3. embeds + intra-batch dedups (engine U4)
 *   4. for each group, calls the assemble_gap_occurrence_group RPC, which holds
 *      an org advisory lock and merges-or-creates atomically (KTD4)
 *   5. re-clusters unpinned gaps into sections (engine U5, AE3-safe)
 *   6. notifies assignees of resurfaced gaps (U7)
 *   7. marks misses processed LAST (durable marker — KTD4)
 *
 * Any thrown error leaves misses unprocessed so Inngest retries; the RPC is
 * idempotent on (meeting_id, utterance_id), so a retry never double-counts.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type VoyageEmbedder } from '@risezome/engine/embed';
import {
  dedupeWithinBatch,
  assignSections,
  proposeSections,
  meanVector,
  GAP_MERGE_MAX_DISTANCE,
  type Embedded,
  type SectionNamer,
  type GapToPlace,
  type SectionRef,
} from '@risezome/engine/gaps';
import { transcriptWithText } from '../../../app/_lib/token-crypto';

const SECTION_COLORS = ['indigo', 'emerald', 'sky', 'amber', 'rose', 'violet', 'teal', 'slate'];

/** Voyage voyage-3-large dimensionality; the knowledge_gaps.embedding column is vector(1024). */
const EMBEDDING_DIM = 1024;

/** Bound the Haiku section-namer call so a hung Anthropic connection degrades to the fallback. */
const NAMER_TIMEOUT_MS = 10_000;

export interface MissRow {
  readonly miss_id: number;
  readonly utterance_id: string | null;
  readonly verbatim_question: string;
  readonly reason: string;
}

export interface OccurrenceInput {
  readonly utterance_id: string | null;
  readonly verbatim_question: string;
  readonly asker_name: string;
  readonly reason: string;
}

export interface AssemblyGroup {
  readonly title: string;
  readonly centroid: number[];
  readonly occurrences: OccurrenceInput[];
}

/** Map utteranceId → speaker name from transcript.data event payloads. */
export function resolveAskers(
  events: ReadonlyArray<{ payload: Record<string, unknown> | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of events) {
    const p = e.payload ?? {};
    const uid = p['utteranceId'];
    const speaker = p['speaker'];
    if (typeof uid === 'string' && typeof speaker === 'string' && speaker.length > 0) {
      map.set(uid, speaker);
    }
  }
  return map;
}

/**
 * Intra-batch dedup (AE1): collapse a meeting's misses into groups, each
 * carrying its centroid + the occurrences that compose it. `embeddings[i]`
 * aligns with `misses[i]`.
 */
export function buildGroups(
  misses: ReadonlyArray<MissRow>,
  embeddings: ReadonlyArray<readonly number[]>,
  askers: Map<string, string>,
): AssemblyGroup[] {
  const items: Array<Embedded<{ miss: MissRow; vector: readonly number[] }>> = misses.map(
    (miss, i) => ({
      item: { miss, vector: embeddings[i] ?? [] },
      vector: embeddings[i] ?? [],
    }),
  );
  const groups = dedupeWithinBatch(items, GAP_MERGE_MAX_DISTANCE);
  return groups.map((g) => {
    const occurrences: OccurrenceInput[] = g.members.map(({ miss }) => ({
      utterance_id: miss.utterance_id,
      verbatim_question: miss.verbatim_question,
      asker_name:
        miss.utterance_id !== null ? (askers.get(miss.utterance_id) ?? 'Unknown') : 'Unknown',
      reason: miss.reason,
    }));
    return {
      // Canonical title = the first phrasing in the group.
      title: g.members[0]!.miss.verbatim_question,
      centroid: g.centroid,
      occurrences,
    };
  });
}

/** Serialize a number[] as a pgvector literal. */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

/** Parse a pgvector value (returned as a string by PostgREST) into number[]. */
export function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

export interface AssembleResult {
  readonly misses: number;
  readonly groups: number;
  readonly created: number;
  readonly resurfaced: number;
}

/**
 * Backfill (plan U6 follow-up): reconstruct `meeting_gap_misses` for a past
 * meeting from the persisted `syntheses` table. A retracted synthesis with
 * reason 'refusal' or 'ungrounded' IS a recorded miss; the verbatim question is
 * recovered from the transcript via trigger_utterance_id. (The 'no_hits' branch
 * never created a synthesis row, so those misses are not recoverable without
 * replaying retrieval — out of scope for this cheap backfill.)
 *
 * Idempotent: skips utterances that already have a miss row, so re-running the
 * backfill (or backfilling a meeting that already captured live misses) never
 * duplicates. Returns the number of new miss rows inserted.
 */
export async function backfillMissesForMeeting(
  service: SupabaseClient,
  meetingId: string,
  orgId: string,
): Promise<number> {
  const { data: retractRows, error: synErr } = await service
    .from('syntheses')
    .select('trigger_utterance_id, retracted_reason')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .eq('status', 'retracted')
    .in('retracted_reason', ['refusal', 'ungrounded']);
  if (synErr !== null) throw new Error(`backfill load syntheses: ${synErr.message}`);
  const retracts = (retractRows ?? []).filter(
    (r): r is { trigger_utterance_id: string; retracted_reason: string } =>
      typeof r.trigger_utterance_id === 'string' && r.trigger_utterance_id.length > 0,
  );
  if (retracts.length === 0) return 0;

  // Recover the verbatim question for each retracted utterance from the transcript.
  // F2: transcript text is encrypted at rest — fetch it decrypted.
  const events = await transcriptWithText(service, meetingId, orgId);
  const textByUtt = new Map<string, string>();
  for (const e of events) {
    const p = e.payload ?? {};
    const uid = p['utteranceId'];
    const text = e.text;
    if (typeof uid === 'string' && typeof text === 'string' && text.length > 0) {
      textByUtt.set(uid, text);
    }
  }

  // Skip utterances that already have a miss row (live capture or a prior backfill).
  const { data: existing } = await service
    .from('meeting_gap_misses')
    .select('utterance_id')
    .eq('meeting_id', meetingId);
  const seen = new Set((existing ?? []).map((r) => r.utterance_id as string | null));

  const toInsert: Array<{
    meeting_id: string;
    org_id: string;
    utterance_id: string;
    verbatim_question: string;
    reason: string;
  }> = [];
  for (const r of retracts) {
    if (seen.has(r.trigger_utterance_id)) continue;
    const text = textByUtt.get(r.trigger_utterance_id);
    if (text === undefined) continue; // can't recover the question — skip
    toInsert.push({
      meeting_id: meetingId,
      org_id: orgId,
      utterance_id: r.trigger_utterance_id,
      verbatim_question: text,
      reason: r.retracted_reason,
    });
    seen.add(r.trigger_utterance_id);
  }
  if (toInsert.length === 0) return 0;

  const { error: insErr } = await service.from('meeting_gap_misses').insert(toInsert);
  if (insErr !== null) throw new Error(`backfill insert misses: ${insErr.message}`);
  return toInsert.length;
}

export async function assembleKnowledgeGaps(args: {
  service: SupabaseClient;
  embedder: VoyageEmbedder;
  sectionNamer: SectionNamer;
  meetingId: string;
  orgId: string;
}): Promise<AssembleResult> {
  const { service, embedder, sectionNamer, meetingId, orgId } = args;

  // 1. Unprocessed misses for this meeting.
  const { data: missRows, error: missErr } = await service
    .from('meeting_gap_misses')
    .select('miss_id, utterance_id, verbatim_question, reason')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .is('processed_at', null);
  if (missErr !== null) throw new Error(`load misses: ${missErr.message}`);
  const misses = (missRows ?? []) as MissRow[];
  if (misses.length === 0) return { misses: 0, groups: 0, created: 0, resurfaced: 0 };

  // 2. Asker resolution from the transcript.
  const { data: events } = await service
    .from('meeting_events')
    .select('payload')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .eq('type', 'transcript.data');
  const askers = resolveAskers((events ?? []) as { payload: Record<string, unknown> | null }[]);

  // 3. Embed + dedup.
  const embedResult = await embedder.embed({
    items: misses.map((m) => ({ text: m.verbatim_question, domain: 'text' as const })),
  });
  const embeddings = misses.map((_, i) => Array.from(embedResult.vectors[i]?.vector ?? []));
  const groups = buildGroups(misses, embeddings, askers);

  // 4. Meeting participants → viewer ids.
  const { data: parts } = await service
    .from('meeting_participants')
    .select('user_id')
    .eq('meeting_id', meetingId);
  const viewerIds = (parts ?? []).map((p) => p.user_id as string);

  // 5. Merge-or-create each group via the locked RPC.
  let created = 0;
  let resurfaced = 0;
  const touchedGapIds: string[] = [];
  for (const g of groups) {
    // A missing/short embedding would serialize to '[]' and throw on the RPC's
    // ::vector(1024) cast, wedging the whole meeting on every retry. Skip the
    // bad group (its misses still get marked processed below) rather than let
    // one bad vector poison every other miss in the meeting.
    if (g.centroid.length !== EMBEDDING_DIM) {
      console.warn(
        `[knowledge-gaps] skipping group with bad embedding dim=${String(g.centroid.length)} meeting=${meetingId}`,
      );
      continue;
    }
    const { data, error } = await service.rpc('assemble_gap_occurrence_group', {
      p_org_id: orgId,
      p_meeting_id: meetingId,
      p_centroid: toVectorLiteral(g.centroid),
      p_title: g.title,
      p_merge_max: GAP_MERGE_MAX_DISTANCE,
      p_occurrences: g.occurrences,
      p_viewer_ids: viewerIds,
    });
    if (error !== null) throw new Error(`assemble group: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (row === undefined || row === null) continue;
    const r = row as {
      gap_id: string;
      created: boolean;
      resurfaced: boolean;
      assignee_id: string | null;
    };
    touchedGapIds.push(r.gap_id);
    if (r.created) created += 1;
    if (r.resurfaced) {
      resurfaced += 1;
      if (r.assignee_id !== null) {
        await createNotification(service, {
          userId: r.assignee_id,
          orgId,
          type: 'gap_resurfaced',
          gapId: r.gap_id,
        });
      }
    }
  }

  // 6. Re-cluster the gaps touched this run into sections (AE3-safe).
  await reclusterSections({ service, orgId, sectionNamer, touchedGapIds });

  // 7. Durable marker LAST.
  const { error: markErr } = await service
    .from('meeting_gap_misses')
    .update({ processed_at: new Date().toISOString() })
    .in(
      'miss_id',
      misses.map((m) => m.miss_id),
    );
  if (markErr !== null) throw new Error(`mark processed: ${markErr.message}`);

  return { misses: misses.length, groups: groups.length, created, resurfaced };
}

/**
 * Place this run's unpinned, uncategorized gaps into existing sections (or
 * propose new ones for clustered leftovers). Never touches pinned gaps or
 * name_locked sections (KTD6 / AE3).
 */
async function reclusterSections(args: {
  service: SupabaseClient;
  orgId: string;
  sectionNamer: SectionNamer;
  touchedGapIds: string[];
}): Promise<void> {
  const { service, orgId, sectionNamer, touchedGapIds } = args;
  if (touchedGapIds.length === 0) return;

  // Existing section centroids, computed from their member gaps' embeddings.
  const { data: allGaps } = await service
    .from('knowledge_gaps')
    .select('gap_id, section_id, embedding, title, section_pinned')
    .eq('org_id', orgId);
  const gaps = (allGaps ?? []) as Array<{
    gap_id: string;
    section_id: string | null;
    embedding: unknown;
    title: string;
    section_pinned: boolean;
  }>;

  const bySection = new Map<string, number[][]>();
  for (const g of gaps) {
    if (g.section_id === null) continue;
    const vec = parseVector(g.embedding);
    if (vec.length === 0) continue;
    const arr = bySection.get(g.section_id) ?? [];
    arr.push(vec);
    bySection.set(g.section_id, arr);
  }
  const sectionRefs: SectionRef[] = [...bySection.entries()].map(([sectionId, vecs]) => ({
    sectionId,
    centroid: meanVector(vecs),
  }));

  // Candidates: gaps touched this run that are unpinned AND currently uncategorized.
  const toPlace: GapToPlace[] = gaps
    .filter((g) => touchedGapIds.includes(g.gap_id) && !g.section_pinned && g.section_id === null)
    .map((g) => ({ gapId: g.gap_id, vector: parseVector(g.embedding), title: g.title }))
    .filter((g) => g.vector.length > 0);
  if (toPlace.length === 0) return;

  const placements = assignSections(toPlace, sectionRefs);
  for (const p of placements) {
    if (p.sectionId !== null) {
      await service
        .from('knowledge_gaps')
        .update({ section_id: p.sectionId })
        .eq('gap_id', p.gapId);
    }
  }

  // Still uncategorized → propose new sections from clusters of 2+.
  const placedIds = new Set(placements.filter((p) => p.sectionId !== null).map((p) => p.gapId));
  const stillUncategorized = toPlace.filter((g) => !placedIds.has(g.gapId));
  const proposed = await proposeSections(stillUncategorized, sectionNamer);
  for (let i = 0; i < proposed.length; i++) {
    const sec = proposed[i]!;
    const sectionId = `sec_${randomUUID()}`;
    const color = SECTION_COLORS[i % SECTION_COLORS.length]!;
    const { error: secErr } = await service.from('knowledge_gap_sections').insert({
      section_id: sectionId,
      org_id: orgId,
      name: sec.name,
      color,
    });
    if (secErr !== null) continue; // a racing meeting may have created an overlapping section; skip
    for (const gapId of sec.gapIds) {
      await service.from('knowledge_gaps').update({ section_id: sectionId }).eq('gap_id', gapId);
    }
  }
}

export async function createNotification(
  service: SupabaseClient,
  n: {
    userId: string;
    orgId: string;
    type: 'gap_assigned' | 'gap_resurfaced';
    gapId: string;
    actorId?: string;
  },
): Promise<void> {
  const { error } = await service.from('notifications').insert({
    user_id: n.userId,
    org_id: n.orgId,
    type: n.type,
    gap_id: n.gapId,
    ...(n.actorId !== undefined && { actor_id: n.actorId }),
  });
  // A dropped notification is not self-healing; surface it rather than swallow.
  if (error !== null) {
    console.warn(
      `[knowledge-gaps] notification insert failed (${n.type}, gap=${n.gapId}): ${error.message}`,
    );
  }
}

const NAMER_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Haiku-backed section namer: turns a cluster's questions into a short topical
 * section name (e.g. "Auth & Identity"). Falls back to "New section" on any
 * failure — naming is a nicety, never a hard dependency.
 */
export function makeSectionNamer(apiKey: string, fetchImpl: typeof fetch = fetch): SectionNamer {
  return async (questions: readonly string[]): Promise<string> => {
    try {
      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(NAMER_TIMEOUT_MS),
        body: JSON.stringify({
          model: NAMER_MODEL,
          max_tokens: 16,
          messages: [
            {
              role: 'user',
              content: `These meeting questions cluster into one topic:\n${questions
                .map((q) => `- ${q}`)
                .join(
                  '\n',
                )}\n\nReply with a short section name (2-4 words, Title Case), nothing else.`,
            },
          ],
        }),
      });
      if (!res.ok) return 'New section';
      const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
      const text = json.content?.find((c) => c.type === 'text')?.text?.trim();
      return text !== undefined && text.length > 0 ? text.slice(0, 60) : 'New section';
    } catch {
      return 'New section';
    }
  };
}
