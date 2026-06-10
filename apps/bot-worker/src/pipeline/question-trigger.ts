// Shared question-lane trigger helpers (KTD4/KTD5).
//
// Extracted verbatim from `src/retrieval.ts` so BOTH the production adapter
// (`maybeRetrieveAndEmit`) and the local-debug REPLAY path
// (`src/debug/local-debug-ws.ts`) apply the SAME two-lane classification,
// question-anchored query build, and semantic near-duplicate-question
// suppression. Before this module the replay called `runPipeline` (the core)
// directly and skipped these adapter-level gates, so a real meeting replayed
// through it OVER-answered relative to prod — every rephrasing of the same
// question produced a fresh synthesis. Sharing the helpers keeps the replay
// faithful without forking the live logic.
//
// All helpers are pure except `embedQuestion` (one Voyage call). The runtime
// ledger (`answeredQuestions`) stays with the caller.

import { type VoyageEmbedder } from '@risezome/engine/embed';
import { cosineDistance } from '@risezome/engine/gaps';
import { classifySubstantiveQuestion } from '@risezome/engine/relevance';
import type { MeetingSummary } from '@risezome/engine/summarize';
import { QUESTION_DUP_WINDOW_MS } from './answer-dedup.js';

/** Lane an utterance takes: a detected substantive question fires immediately
 *  (bypassing the cooldown); everything else is ambient. */
export type TriggerLane = 'question' | 'ambient';

/** Classify the two-lane trigger for an utterance. */
export function classifyLane(utteranceText: string): TriggerLane {
  return classifySubstantiveQuestion(utteranceText).isQuestion ? 'question' : 'ambient';
}

// Near-duplicate question suppression (KTD4). A question semantically close to
// one already ANSWERED this meeting (within the recency window) is suppressed so
// repeats/rephrasings don't re-answer or re-spend. Tighter than the gap-merge
// distance (0.22) — questions must be genuinely the same to suppress.
export const QUESTION_DUP_DISTANCE = (() => {
  // Guard against a non-numeric env value: parseFloat('abc') is NaN, and
  // `cosineDistance(...) <= NaN` is always false — which would silently disable
  // dedup entirely. Fall back to the default on NaN / non-positive.
  const parsed = Number.parseFloat(process.env.RISEZOME_QUESTION_DUP_DISTANCE ?? '0.15');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.15;
})();

/**
 * LOOSER similarity bound used to CONFIRM the same-source-set suppression
 * (Mechanism B). A question that passed the strict near-duplicate check
 * (distance > QUESTION_DUP_DISTANCE) but retrieves an already-answered source
 * set is suppressed ONLY if it's at least loosely similar (≤ this distance) to
 * a recently-answered question — i.e. it reads as a REPHRASE the strict check
 * missed. A genuinely different question (> this distance) about the same docs
 * goes through: suppressing it was the false-silence bug (a NEW question about
 * the same two documents produced nothing).
 */
export const QUESTION_DUP_CONFIRM_DISTANCE = (() => {
  const parsed = Number.parseFloat(process.env.RISEZOME_QUESTION_DUP_CONFIRM_DISTANCE ?? '0.30');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.3;
})();

export async function embedQuestion(
  embedder: VoyageEmbedder,
  text: string,
  logger: { warn: (obj: object, msg?: string) => void },
): Promise<number[] | undefined> {
  try {
    const result = await embedder.embed({ items: [{ text, domain: 'text' }], purpose: 'query' });
    const vec = result.vectors[0]?.vector;
    return vec === undefined ? undefined : Array.from(vec);
  } catch (err) {
    // Dedup is best-effort; never block a fire on an embed error — but surface it
    // (project convention: no silent swallowing).
    logger.warn({ err }, 'retrieval.dedup.embed_failed');
    return undefined;
  }
}

export function isNearDuplicateQuestion(
  vec: readonly number[],
  history: readonly { embedding: number[]; at: number }[],
  now: number,
  /** Similarity bound; defaults to the strict dedup distance. Mechanism B's
   *  confirmation pass calls this with QUESTION_DUP_CONFIRM_DISTANCE. */
  maxDistance: number = QUESTION_DUP_DISTANCE,
): boolean {
  return history.some(
    (e) => now - e.at < QUESTION_DUP_WINDOW_MS && cosineDistance(vec, e.embedding) <= maxDistance,
  );
}

// Question-anchored query (KTD5). A standalone question embeds as itself so
// surrounding off-domain talk can't dilute it. A fragment / follow-up needs a
// referent, so it (and only it) gets a minimal context slice: the immediately-
// preceding final + the rolling-summary topic.
const FOLLOWUP_START = /^(and|or|but|so|what about|how about|and the|or the|what's that|then)\b/;
const FOLLOWUP_MAX_WORDS = 3;

export function buildQuestionQuery(
  question: string,
  recentFinals: readonly string[],
  lastSummary: MeetingSummary | undefined,
): string {
  const q = question.trim();
  const words = q.split(/\s+/).filter((w) => w.length > 0).length;
  const isFollowup = words <= FOLLOWUP_MAX_WORDS || FOLLOWUP_START.test(q.toLowerCase());
  if (!isFollowup) return q; // standalone question — undiluted
  const parts: string[] = [];
  // recentFinals' last element IS the question (pushed on entry); the one before
  // it is the conversational antecedent.
  const priorFinal = recentFinals.length >= 2 ? recentFinals[recentFinals.length - 2] : undefined;
  if (priorFinal !== undefined && priorFinal.trim().length > 0) parts.push(priorFinal.trim());
  const topic = lastSummary?.current_topic?.trim();
  if (topic !== undefined && topic.length > 0) parts.push(topic);
  parts.push(q);
  return parts.join(' ').trim();
}
