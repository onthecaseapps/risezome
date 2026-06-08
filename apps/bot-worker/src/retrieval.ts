import { type VoyageEmbedder } from '@risezome/engine/embed';
import type { Synthesizer } from '@risezome/engine/synthesize';
import { hybridSearch, isLowConfidenceHits } from './corpus-search';
import { optionalReranker } from './reranker';
import { expandWinnersToParents, parentDocEnabled, dedupeByDoc } from './parent-doc';
import { optionalQueryExpander } from './query-expand';
import { type MissRecord } from '@risezome/engine/gaps';
import { type RelevanceClassifier } from '@risezome/engine/relevance';
import { type Classifier } from '@risezome/engine/router';
import { type SkillRegistry } from '@risezome/engine/skills';
import type { MeetingSummary } from '@risezome/engine/summarize';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runPipeline } from './pipeline/core.js';
import type { PipelineDeps, PipelineInput, PipelineSink } from './pipeline/contract.js';
import { createSupabaseSink } from './pipeline/sink-supabase.js';
import {
  effectiveWindow,
  isDuplicateAnswerSourceSet,
  addConsumedFinals,
  CONSUMED_FINALS_CAP,
  QUESTION_DUP_WINDOW_MS,
} from './pipeline/answer-dedup.js';
import {
  classifyLane,
  embedQuestion,
  isNearDuplicateQuestion,
  buildQuestionQuery,
} from './pipeline/question-trigger.js';

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
// Mechanism A — CONSUMED_FINALS_CAP and the answered-source recency window
// (QUESTION_DUP_WINDOW_MS) now live in ./pipeline/answer-dedup.ts, shared with
// the local-debug path so both apply identical dedup.


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

// Near-duplicate question suppression (KTD4), two-lane classification, and the
// question-anchored query build now live in ./pipeline/question-trigger.js,
// shared verbatim with the local-debug REPLAY path so both apply identical
// gates. `QUESTION_DUP_DISTANCE` and `QUESTION_DUP_WINDOW_MS` are re-homed there
// / in answer-dedup.js respectively.

// Mechanism A's `effectiveWindow` is imported from ./pipeline/answer-dedup.js
// (shared verbatim with the local-debug path).

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

/** Runtime-recording hooks the adapter owns and threads into WHATEVER sink it
 *  builds — so dedup/voiding state (answeredQuestions/consumedFinals/
 *  answeredSourceSets) is maintained identically whether the output is the prod
 *  Supabase sink or the debug WS+trace sink. `onGroundedAnswer` closes over this
 *  call's lane/effective-window/question-vector and the injected clock. */
export interface SinkWiring {
  readonly onGroundedAnswer: (text: string, sourceDocIds?: readonly string[]) => void;
  readonly onMiss?: (miss: MissRecord) => void;
  readonly onSynthesisRequested?: () => void;
}

/** Builds the output sink from the adapter's runtime-recording wiring. Prod
 *  passes nothing (defaults to the Supabase sink); the debug sidecar passes a
 *  factory that builds the WS+trace sink. (KTD2.) */
export type SinkFactory = (wiring: SinkWiring) => PipelineSink;

export async function maybeRetrieveAndEmit(args: {
  runtime: RetrievalRuntime;
  /** Injected clock for the time-based gates (cooldown, question ceiling,
   *  near-duplicate recency). Defaults to `Date.now()`. Replay passes the
   *  utterance's meeting-logical `startMs` so replay speed can't distort
   *  suppression; live-mic/prod omit it. (KTD3.) */
  now?: number;
  /** Optional output-sink factory. Omitted ⇒ the prod Supabase sink. The debug
   *  path passes a WS+trace sink factory. (KTD2.) */
  createSink?: SinkFactory;
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
  const now = args.now ?? Date.now();
  const lane = classifyLane(args.utteranceText);

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
      // Prune the ledger by the recency window first (caller owns the runtime
      // state), then run the shared pure predicate.
      args.runtime.answeredSourceSets = args.runtime.answeredSourceSets.filter(
        (e) => now - e.at < QUESTION_DUP_WINDOW_MS,
      );
      return isDuplicateAnswerSourceSet(
        docIds,
        args.runtime.answeredSourceSets,
        now,
        QUESTION_DUP_WINDOW_MS,
      );
    },
  };

  // ── Sink wiring (KTD2) ───────────────────────────────────────────────
  // The runtime-recording hooks the adapter OWNS, threaded into whatever sink it
  // builds. `onGroundedAnswer` records dedup state ONLY when the answer grounded
  // (never on a refusal), then forwards to the caller — identical on prod and
  // debug so dedup/voiding stay in lockstep across sinks.
  const sinkWiring: SinkWiring = {
    onGroundedAnswer: (text: string, sourceDocIds: readonly string[] = []): void => {
      if (lane === 'question' && questionVec !== undefined) {
        args.runtime.answeredQuestions.push({ embedding: questionVec, at: now });
      }
      // Mechanism A: void the transcript spans that produced THIS answer — the
      // effective window for this call — so they can't re-seed the next
      // question's query/context. Append, dedupe, cap to the most-recent bound.
      args.runtime.consumedFinals = addConsumedFinals(
        args.runtime.consumedFinals,
        effective,
        CONSUMED_FINALS_CAP,
      );
      // Mechanism B (record side): remember this answer's grounded source set so
      // a later question retrieving the same set is skipped. Only when there's a
      // real source set (a pure tool answer carries none).
      if (sourceDocIds.length > 0) {
        args.runtime.answeredSourceSets.push({ docIds: Array.from(new Set(sourceDocIds)), at: now });
      }
      args.onGroundedAnswer?.(text);
    },
    ...(args.onMiss !== undefined ? { onMiss: args.onMiss } : {}),
    ...(args.onSynthesisRequested !== undefined
      ? { onSynthesisRequested: args.onSynthesisRequested }
      : {}),
  };

  // ── Output sink: prod Supabase sink by default, injected factory for debug ──
  // The Supabase sink owns card persistence + Realtime broadcast, flash-fix
  // buffered synthesis, stale-card retraction (via runtime.liveCardByDocId), and
  // knowledge-gap miss capture. No recordTrace ⇒ the core runs trace-free. A
  // debug factory builds the WS+trace sink instead. (KTD2.)
  const sink: PipelineSink = args.createSink
    ? args.createSink(sinkWiring)
    : createSupabaseSink({
        db: args.db,
        meetingId: args.meetingId,
        orgId: args.orgId,
        liveCardByDocId: args.runtime.liveCardByDocId,
        logger: args.logger,
        ...(sinkWiring.onMiss !== undefined ? { onMiss: sinkWiring.onMiss } : {}),
        onGroundedAnswer: sinkWiring.onGroundedAnswer,
        ...(sinkWiring.onSynthesisRequested !== undefined
          ? { onSynthesisRequested: sinkWiring.onSynthesisRequested }
          : {}),
      });

  return runPipeline(input, deps, sink);
}
