import { type VoyageEmbedder } from '@risezome/engine/embed';
import type { Synthesizer } from '@risezome/engine/synthesize';
import { hybridSearch, isLowConfidenceHits } from './corpus-search';
import { optionalReranker } from './reranker';
import { expandWinnersToParents, parentDocEnabled, dedupeByDoc } from './parent-doc';
import { optionalQueryExpander } from './query-expand';
import { type MissRecord, cosineDistance } from '@risezome/engine/gaps';
import { type RelevanceClassifier, classifySubstantiveQuestion } from '@risezome/engine/relevance';
import { type Classifier } from '@risezome/engine/router';
import { type SkillRegistry } from '@risezome/engine/skills';
import type { MeetingSummary } from '@risezome/engine/summarize';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runPipeline } from './pipeline/core.js';
import type { PipelineDeps, PipelineInput } from './pipeline/contract.js';
import { createSupabaseSink } from './pipeline/sink-supabase.js';

/**
 * Production Recall retrieval/synthesis loop. Since U2 this is a THIN ADAPTER:
 * the heavy lifting (pre-retrieval relevance gate → embed → hybrid search →
 * CRAG → dedup/parent-expand → emit cards → synthesize → citation-verify) lives
 * in the shared, sink-agnostic core (./pipeline/core.ts), which prod, the
 * dev-sidecar, and the eval all call. This adapter owns only:
 *   1. the prod transcription-source shape — the rolling window of recent
 *      finals + the env-gated key_terms boost as the embed/lexical query text;
 *   2. the throttling/cooldown gates (one retrieval per 10s);
 *   3. building PipelineInput + PipelineDeps + a Supabase PipelineSink and
 *      calling runPipeline.
 *
 * BEHAVIOR CHANGE (KTD3, intended): the core gates PRE-retrieval, so a gated
 * (filler / off-topic) utterance now emits NO cards. Prod previously emitted
 * cards then gated only synthesis; moving the gate before embed/search is the
 * card-level precision fix. The flash-fix buffered synthesis, stale-card
 * retraction, knowledge-gap miss capture, and org-scoping are all preserved —
 * they now live in the Supabase sink (./pipeline/sink-supabase.ts).
 *
 * Throttling:
 *   - At least UTTERANCE_THRESHOLD final utterances since last retrieval
 *   - AND at least COOLDOWN_MS elapsed
 * Both gates keep us from hammering Voyage / Postgres on a chatty meeting.
 */

// Retrieve on EVERY finalized utterance — a clear single question should fire
// retrieval immediately rather than wait for two more utterances. The 10s
// cooldown still prevents spam (max one retrieval per 10s); the relevance gate
// (now pre-retrieval, in the core) filters filler before the expensive
// embed/search/synthesis work.
const UTTERANCE_THRESHOLD = 1;
const COOLDOWN_MS = 10_000; // ... but at most once per 10s
// Canonical top-K is resolved in the core (5 — U1 resolution). Prod historically
// used 3; the gate + vector floor hold precision, not a tight K.
const WINDOW_UTTERANCES = 8; // last 8 final utterances form the query
// Mechanism A — bound on the answered-transcript-span ledger so a long meeting
// can't grow `consumedFinals` unboundedly. Comfortably larger than the rolling
// window, so every still-in-window answered utterance stays voidable.
const CONSUMED_FINALS_CAP = 60;


/**
 * Strict "about-our-work" routing (U3). When true, substantive questions are
 * routed through the LLM judge too, so the about-our-work gate fires on
 * questions, not just `ambiguous` utterances. Default OFF; flip
 * RISEZOME_RELEVANCE_STRICT=true to enable. The core reads this via
 * `deps.relevanceStrict`. Eval A/B: precision 84%→98%, over-refusal flat.
 */
const RELEVANCE_STRICT = process.env.RISEZOME_RELEVANCE_STRICT === 'true';

// Two-lane triggering (KTD3). A detected substantive question fires immediately,
// bypassing the cooldown, so a real question asked amid filler is never dropped
// (the original incident). Cost is bounded by a HIGH abuse ceiling — set well
// above any normal conversational question rate — so only runaway/abusive
// volume is throttled. Over the ceiling, a question falls back to the ambient
// cooldown (best-effort), not a hard drop. Env-overridable like the rest.
const QUESTION_MAX_PER_MIN =
  Number.parseInt(process.env.RISEZOME_QUESTION_MAX_PER_MIN ?? '6', 10) || 6;
const QUESTION_MAX_PER_MEETING =
  Number.parseInt(process.env.RISEZOME_QUESTION_MAX_PER_MEETING ?? '60', 10) || 60;
const QUESTION_RATE_WINDOW_MS = 60_000;

// Near-duplicate question suppression (KTD4). A question semantically close to
// one already ANSWERED this meeting (within the recency window) is suppressed so
// repeats/rephrasings don't re-answer or re-spend. Tighter than the gap-merge
// distance (0.22) — questions must be genuinely the same to suppress.
const QUESTION_DUP_DISTANCE = (() => {
  // Guard against a non-numeric env value: parseFloat('abc') is NaN, and
  // `cosineDistance(...) <= NaN` is always false — which would silently disable
  // dedup entirely. Fall back to the default on NaN / non-positive.
  const parsed = Number.parseFloat(process.env.RISEZOME_QUESTION_DUP_DISTANCE ?? '0.15');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.15;
})();
const QUESTION_DUP_WINDOW_MS =
  Number.parseInt(process.env.RISEZOME_QUESTION_DUP_WINDOW_MS ?? '300000', 10) || 300_000;

async function embedQuestion(
  embedder: VoyageEmbedder,
  text: string,
  logger: { warn: (obj: object, msg?: string) => void },
): Promise<number[] | undefined> {
  try {
    const result = await embedder.embed({ items: [{ text, domain: 'text' }] });
    const vec = result.vectors[0]?.vector;
    return vec === undefined ? undefined : Array.from(vec);
  } catch (err) {
    // Dedup is best-effort; never block a fire on an embed error — but surface it
    // (project convention: no silent swallowing).
    logger.warn({ err }, 'retrieval.dedup.embed_failed');
    return undefined;
  }
}

function isNearDuplicateQuestion(
  vec: readonly number[],
  history: readonly { embedding: number[]; at: number }[],
  now: number,
): boolean {
  return history.some(
    (e) => now - e.at < QUESTION_DUP_WINDOW_MS && cosineDistance(vec, e.embedding) <= QUESTION_DUP_DISTANCE,
  );
}

// Question-anchored query (KTD5). A standalone question embeds as itself so
// surrounding off-domain talk can't dilute it. A fragment / follow-up needs a
// referent, so it (and only it) gets a minimal context slice: the immediately-
// preceding final + the rolling-summary topic.
const FOLLOWUP_START = /^(and|or|but|so|what about|how about|and the|or the|what's that|then)\b/;
const FOLLOWUP_MAX_WORDS = 3;

function buildQuestionQuery(
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

/**
 * Mechanism A — the EFFECTIVE window: `recentFinals` with any utterance text
 * present in `consumedFinals` (already answered) removed, BUT the current
 * utterance (the last element — the new, not-yet-answered question) is ALWAYS
 * kept. This is the view that feeds all question UNDERSTANDING (query build,
 * ambient join, synthesizer recentContext); the raw `recentFinals` rolling
 * window is unaffected.
 */
function effectiveWindow(
  recentFinals: readonly string[],
  consumedFinals: readonly string[],
): string[] {
  if (recentFinals.length === 0) return [];
  const consumed = new Set(consumedFinals);
  const lastIdx = recentFinals.length - 1;
  return recentFinals.filter((text, i) => i === lastIdx || !consumed.has(text));
}

export interface RetrievalRuntime {
  /** Concatenated text of recent final utterances (the rolling query window). */
  recentFinals: string[];
  utteranceCountSinceLastRetrieval: number;
  lastRetrievalAt: number;
  /** QUESTION-lane fire timestamps within the last minute (per-minute ceiling). */
  questionFireTimestamps: number[];
  /** Total QUESTION-lane fires this meeting (per-meeting ceiling). */
  questionFireCount: number;
  /** Embeddings + timestamps of questions ANSWERED (grounded) this meeting,
   *  for near-duplicate suppression. Recency-pruned. */
  answeredQuestions: { embedding: number[]; at: number }[];
  /**
   * Mechanism A — verbatim text of recent final utterances that have ALREADY
   * produced a grounded answer this meeting. Removed from the EFFECTIVE window
   * (derived query/context) so lingering answered transcript can't re-seed the
   * next question's query and re-answer the same thing. Deduped + bounded
   * (CONSUMED_FINALS_CAP). The raw `recentFinals` rolling window is untouched.
   */
  consumedFinals: string[];
  /**
   * Mechanism B — grounded source-doc SETS answered this meeting (+ timestamp),
   * recency-pruned by QUESTION_DUP_WINDOW_MS. A new question whose surviving
   * source set duplicates one of these (adds no new source) is skipped before
   * cards are emitted.
   */
  answeredSourceSets: { docIds: string[]; at: number }[];
  /**
   * Most recent cardId surfaced for a given docId in this meeting. Drives the
   * stale-card retractor (now in the Supabase sink): a new card for a docId that
   * already has a live (non-retracted, non-pinned) card retracts the prior one.
   */
  liveCardByDocId: Map<string, string>;
  /**
   * The meeting's effective source set (teams restructure U4): the union of its
   * attendees' teams' sources, resolved ONCE per meeting and cached. Always a
   * defined array after resolution (possibly empty ⇒ the meeting retrieves
   * nothing from the corpus). `effectiveSourceIdsResolved` guards the lazy
   * one-time resolve (an empty array is a valid resolved value).
   */
  effectiveSourceIds: readonly string[];
  effectiveSourceIdsResolved: boolean;
}

export function newRetrievalRuntime(): RetrievalRuntime {
  return {
    recentFinals: [],
    utteranceCountSinceLastRetrieval: 0,
    lastRetrievalAt: 0,
    questionFireTimestamps: [],
    questionFireCount: 0,
    answeredQuestions: [],
    consumedFinals: [],
    answeredSourceSets: [],
    liveCardByDocId: new Map<string, string>(),
    effectiveSourceIds: [],
    effectiveSourceIdsResolved: false,
  };
}

export async function maybeRetrieveAndEmit(args: {
  runtime: RetrievalRuntime;
  utteranceText: string;
  utteranceId: string;
  meetingId: string;
  orgId: string;
  db: SupabaseClient;
  embedder: VoyageEmbedder;
  /** Optional Anthropic synthesizer. When present, the core synthesizes across
   *  the surfaced cards and the Supabase sink streams the buffered (flash-fix)
   *  synthesis broadcasts to the live page. */
  synthesizer?: Synthesizer;
  /** Called with the grounded answer body when a synthesis succeeds (not
   *  refused/ungrounded). Closes the loop: feeding it to the summarizer retires
   *  the open question it resolved. */
  onGroundedAnswer?: (text: string) => void;
  /** Called when a synthesis is requested (the relevance gate passed and an
   *  answer is being produced). The demand signal that lazily refreshes a stale
   *  rolling summary. */
  onSynthesisRequested?: () => void;
  /** Called when the copilot attempted a question but couldn't ground an answer
   *  — zero-hit retrieval, refusal, or ungrounded suppression. Records a
   *  knowledge-gap miss (U3). The no_hits branch is gated on the relevance
   *  heuristic in the core so filler never becomes a gap (AE6). */
  onMiss?: (miss: MissRecord) => void;
  /** Optional LLM relevance classifier. Used for `ambiguous` and (when strict)
   *  `clearly_substantive`; `clearly_filler` short-circuits with no API call.
   *  Absent ⇒ ambiguous utterances fail-open to surfacing. */
  relevanceClassifier?: RelevanceClassifier;
  /** Optional router classifier — paired with `skillRegistry` (non-empty) and a
   *  tool-shaped utterance to dispatch a skill in parallel with embed+retrieve.
   *  The skill result rides into synthesis at source[0]. */
  classifier?: Classifier;
  /** Optional skill registry. See `classifier`. */
  skillRegistry?: SkillRegistry;
  /** Snapshot of the rolling summary at call-fire time (classifier context +
   *  env-gated key_terms boost + synthesizer recentContext). Captured atomically
   *  by the caller so an in-flight refresh can't torn-read it mid-pipeline. */
  lastSummary?: MeetingSummary;
  logger: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}): Promise<{ emitted: number; skipped?: string }> {
  // ── Source seam: maintain the rolling window of recent finals ────────
  args.runtime.recentFinals.push(args.utteranceText);
  while (args.runtime.recentFinals.length > WINDOW_UTTERANCES) {
    args.runtime.recentFinals.shift();
  }
  args.runtime.utteranceCountSinceLastRetrieval += 1;

  // ── Two-lane triggering (KTD3) ───────────────────────────────────────
  // A detected substantive question takes the QUESTION lane: it bypasses the
  // cooldown so a real question is never throttled out (the original incident).
  // Everything else takes the AMBIENT lane and keeps the cost-budgeted cooldown.
  const now = Date.now();
  const lane: 'question' | 'ambient' = classifySubstantiveQuestion(args.utteranceText)
    .isQuestion
    ? 'question'
    : 'ambient';

  // ── Build the query text (lane-aware; KTD5) ──────────────────────────
  // QUESTION lane: anchor on the question utterance (+ minimal context for
  // fragments). AMBIENT lane: the rolling window of recent finals. Built BEFORE
  // the dedup embed (latency U1) so the question lane can embed the query text
  // ONCE and reuse that vector for both near-duplicate suppression and retrieval
  // — the question lane applies no key_terms boost, so the vector equals what the
  // core's embed step would have produced. The env-gated key_terms boost
  // (ambient-only) is still applied by the core's keyTermsBoost(input) at embed
  // time; the ambient lane therefore does NOT reuse a precomputed vector.
  // Mechanism A: derive the effective window (answered spans voided, current
  // utterance always kept) and use it EVERYWHERE recentFinals feeds question
  // understanding. Built BEFORE the grounded callback marks this call's spans
  // consumed, so the current question is never voided before it's answered.
  const effective = effectiveWindow(args.runtime.recentFinals, args.runtime.consumedFinals);
  const queryText =
    lane === 'question'
      ? buildQuestionQuery(args.utteranceText, effective, args.lastSummary)
      : effective.join(' ').trim();
  if (queryText.length === 0) return { emitted: 0, skipped: 'empty_query' };

  // ── Near-duplicate question suppression (KTD4) ───────────────────────
  // Embed the QUERY TEXT and suppress if it's close to one already answered this
  // meeting. New/rephrased questions fire. Recorded only on a grounded answer
  // (below), so a refused question can still be genuinely re-asked. The embed is
  // the ONLY async step; it runs BEFORE the gate/commit below so the ceiling's
  // read-modify-write stays synchronous (atomic under the event loop) — two
  // concurrent question utterances can't both read an under-cap ceiling across
  // an await and both bypass it. The resulting vector is REUSED for retrieval
  // (latency U1), eliminating a second embed round-trip per question.
  let questionVec: number[] | undefined;
  if (lane === 'question') {
    args.runtime.answeredQuestions = args.runtime.answeredQuestions.filter(
      (e) => now - e.at < QUESTION_DUP_WINDOW_MS,
    );
    questionVec = await embedQuestion(args.embedder, queryText, args.logger);
    if (questionVec !== undefined && isNearDuplicateQuestion(questionVec, args.runtime.answeredQuestions, now)) {
      return { emitted: 0, skipped: 'duplicate_question' };
    }
  }

  // ── Synchronous gate + commit (NO await below this point) ────────────
  // Per-minute question budget (prune the rolling window first).
  args.runtime.questionFireTimestamps = args.runtime.questionFireTimestamps.filter(
    (t) => now - t < QUESTION_RATE_WINDOW_MS,
  );
  const overQuestionCeiling =
    args.runtime.questionFireTimestamps.length >= QUESTION_MAX_PER_MIN ||
    args.runtime.questionFireCount >= QUESTION_MAX_PER_MEETING;

  // The cooldown applies to ambient fires, and to question fires only when they
  // are over the abuse ceiling (best-effort throttle, not a hard drop).
  const mustRespectCooldown = lane === 'ambient' || overQuestionCeiling;

  // NOTE: UTTERANCE_THRESHOLD applies to BOTH lanes. With the default of 1 and
  // the counter incremented on entry, the first utterance always passes; raising
  // it would gate questions too.
  if (args.runtime.utteranceCountSinceLastRetrieval < UTTERANCE_THRESHOLD) {
    return { emitted: 0, skipped: 'below_utterance_threshold' };
  }
  if (mustRespectCooldown && now - args.runtime.lastRetrievalAt < COOLDOWN_MS) {
    return { emitted: 0, skipped: lane === 'question' ? 'question_ceiling' : 'cooldown' };
  }

  args.runtime.utteranceCountSinceLastRetrieval = 0;
  args.runtime.lastRetrievalAt = now;
  if (lane === 'question') {
    args.runtime.questionFireTimestamps.push(now);
    args.runtime.questionFireCount += 1;
  }

  // recentContext for the synthesizer: rolling-summary prose at head (longest-
  // range memory), then recent finals excluding the current utterance (which IS
  // the query). Mirrors the prior in-pipeline construction.
  const recentContext: string[] = [];
  if (args.lastSummary !== undefined && args.lastSummary.summary.length > 0) {
    recentContext.push(args.lastSummary.summary);
  }
  // Mechanism A: the effective window (answered spans voided) excluding the
  // current utterance (which IS the query).
  for (const finalText of effective.slice(0, -1)) {
    recentContext.push(finalText);
  }

  // ── PipelineInput (the source seam) ──────────────────────────────────
  const input: PipelineInput = {
    utteranceText: args.utteranceText,
    utteranceId: args.utteranceId,
    meetingId: args.meetingId,
    orgId: args.orgId,
    queryText,
    lane,
    // Latency U1: reuse the dedup embed as the retrieval embed (question lane).
    ...(questionVec !== undefined ? { queryVector: questionVec } : {}),
    ...(recentContext.length > 0 ? { recentContext } : {}),
    ...(args.lastSummary !== undefined ? { lastSummary: args.lastSummary } : {}),
  };

  // ── Effective source set (teams restructure U4) ──────────────────────
  // Resolve the meeting's retrieval scope ONCE (union of attendees' teams'
  // sources) and cache it on the runtime. Fail CLOSED: a resolution error
  // leaves the set empty (retrieve nothing) rather than over-surfacing the
  // whole-org corpus.
  if (!args.runtime.effectiveSourceIdsResolved) {
    const { data, error } = await args.db.rpc('meeting_effective_source_ids', {
      p_meeting_id: args.meetingId,
    });
    if (error !== null) {
      args.logger.warn({ err: error }, 'retrieval.effective-sources.failed');
      args.runtime.effectiveSourceIds = [];
    } else {
      args.runtime.effectiveSourceIds = (Array.isArray(data) ? data : []).map((r) =>
        typeof r === 'string' ? r : (Object.values(r as object)[0] as string),
      );
    }
    args.runtime.effectiveSourceIdsResolved = true;
  }
  const effectiveSourceIds = args.runtime.effectiveSourceIds;

  // ── PipelineDeps (the injected capabilities) ─────────────────────────
  const deps: PipelineDeps = {
    db: args.db,
    embedder: args.embedder,
    ...(args.synthesizer !== undefined ? { synthesizer: args.synthesizer } : {}),
    ...(args.relevanceClassifier !== undefined
      ? { relevanceClassifier: args.relevanceClassifier }
      : {}),
    ...(args.classifier !== undefined ? { routerClassifier: args.classifier } : {}),
    ...(args.skillRegistry !== undefined ? { skillRegistry: args.skillRegistry } : {}),
    // U4: inject the meeting's effective source set so every corpus search is
    // hard-filtered to the attendees' teams' sources.
    hybridSearch: (params) => hybridSearch(args.db, { ...params, sourceIds: effectiveSourceIds }),
    isLowConfidenceHits,
    optionalReranker,
    optionalQueryExpander,
    dedupeByDoc,
    expandWinnersToParents: (orgId, winners) => expandWinnersToParents(args.db, orgId, winners),
    parentDocEnabled,
    logger: args.logger,
    relevanceStrict: RELEVANCE_STRICT,
    // Mechanism B (read side): true when the candidate grounded source set
    // duplicates a recent answered set — non-empty AND every candidate docId is
    // contained in a single recent `answeredSourceSets` entry (the new answer
    // would add no new source). Order-independent; recency-pruned by the same
    // window as answeredQuestions. Synchronous (no await) — read-only on the
    // runtime, safe to call from the core before card emit.
    isDuplicateAnswerSources: (docIds: readonly string[]): boolean => {
      if (docIds.length === 0) return false;
      args.runtime.answeredSourceSets = args.runtime.answeredSourceSets.filter(
        (e) => now - e.at < QUESTION_DUP_WINDOW_MS,
      );
      return args.runtime.answeredSourceSets.some((entry) => {
        const answered = new Set(entry.docIds);
        return docIds.every((id) => answered.has(id));
      });
    },
  };

  // ── Supabase PipelineSink (the prod output seam) ─────────────────────
  // Owns card persistence + Realtime broadcast, the flash-fix buffered synthesis
  // broadcasts, stale-card retraction (via runtime.liveCardByDocId), and
  // knowledge-gap miss capture. No recordTrace ⇒ the core runs trace-free.
  const sink = createSupabaseSink({
    db: args.db,
    meetingId: args.meetingId,
    orgId: args.orgId,
    liveCardByDocId: args.runtime.liveCardByDocId,
    logger: args.logger,
    ...(args.onMiss !== undefined ? { onMiss: args.onMiss } : {}),
    // Record dedup state ONLY when the answer grounded (onGroundedAnswer never
    // fires on a refusal), then forward to the caller.
    onGroundedAnswer: (text: string, sourceDocIds: readonly string[] = []): void => {
      if (lane === 'question' && questionVec !== undefined) {
        args.runtime.answeredQuestions.push({ embedding: questionVec, at: now });
      }
      // Mechanism A: void the transcript spans that produced THIS answer — the
      // effective window for this call — so they can't re-seed the next
      // question's query/context. Append, dedupe, cap to the most-recent bound.
      const merged = [...args.runtime.consumedFinals, ...effective];
      const seen = new Set<string>();
      const deduped: string[] = [];
      // Iterate newest-last so the cap keeps the freshest entries.
      for (const txt of merged) {
        if (txt.length === 0 || seen.has(txt)) continue;
        seen.add(txt);
        deduped.push(txt);
      }
      args.runtime.consumedFinals =
        deduped.length > CONSUMED_FINALS_CAP ? deduped.slice(-CONSUMED_FINALS_CAP) : deduped;
      // Mechanism B (record side): remember this answer's grounded source set so
      // a later question retrieving the same set is skipped. Only when there's a
      // real source set (a pure tool answer carries none).
      if (sourceDocIds.length > 0) {
        args.runtime.answeredSourceSets.push({ docIds: Array.from(new Set(sourceDocIds)), at: now });
      }
      args.onGroundedAnswer?.(text);
    },
    ...(args.onSynthesisRequested !== undefined
      ? { onSynthesisRequested: args.onSynthesisRequested }
      : {}),
  });

  return runPipeline(input, deps, sink);
}
