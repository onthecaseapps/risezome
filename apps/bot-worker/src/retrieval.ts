import { type VoyageEmbedder } from '@risezome/engine/embed';
import type { Synthesizer } from '@risezome/engine/synthesize';
import { hybridSearch, isLowConfidenceHits } from './corpus-search';
import { optionalReranker } from './reranker';
import { expandWinnersToParents, parentDocEnabled, dedupeByDoc } from './parent-doc';
import { optionalQueryExpander } from './query-expand';
import { type MissRecord } from '@risezome/engine/gaps';
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

// Voyage embeddings are trained on natural sentences, not keyword bags.
// Concatenating key_terms can EITHER boost recall on short follow-up utterances
// OR degrade similarity. Ship gated behind an env flag. Default OFF.
const KEY_TERMS_BOOST_ENABLED = process.env.RISEZOME_KEY_TERMS_BOOST === 'true';

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

export interface RetrievalRuntime {
  /** Concatenated text of recent final utterances (the rolling query window). */
  recentFinals: string[];
  utteranceCountSinceLastRetrieval: number;
  lastRetrievalAt: number;
  /** QUESTION-lane fire timestamps within the last minute (per-minute ceiling). */
  questionFireTimestamps: number[];
  /** Total QUESTION-lane fires this meeting (per-meeting ceiling). */
  questionFireCount: number;
  /**
   * Most recent cardId surfaced for a given docId in this meeting. Drives the
   * stale-card retractor (now in the Supabase sink): a new card for a docId that
   * already has a live (non-retracted, non-pinned) card retracts the prior one.
   */
  liveCardByDocId: Map<string, string>;
}

export function newRetrievalRuntime(): RetrievalRuntime {
  return {
    recentFinals: [],
    utteranceCountSinceLastRetrieval: 0,
    lastRetrievalAt: 0,
    questionFireTimestamps: [],
    questionFireCount: 0,
    liveCardByDocId: new Map<string, string>(),
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

  // ── Build the query text (lane-aware; KTD5) ──────────────────────────
  // QUESTION lane: anchor on the question utterance (+ minimal context for
  // fragments). AMBIENT lane: the rolling window of recent finals, optionally
  // boosted with the summary's key_terms (env-gated). The relevance HEURISTIC +
  // judge, by contrast, see only the single latest utterance — the core takes
  // both verbatim via PipelineInput (utteranceText vs queryText).
  const queryText =
    lane === 'question'
      ? buildQuestionQuery(args.utteranceText, args.runtime.recentFinals, args.lastSummary)
      : args.runtime.recentFinals.join(' ').trim();
  if (queryText.length === 0) return { emitted: 0, skipped: 'empty_query' };
  // key_terms boost is ambient-only — appending the meeting's key terms to a
  // question would re-introduce the off-domain dilution KTD5 removes.
  const keyTermsBoost =
    lane === 'ambient' &&
    KEY_TERMS_BOOST_ENABLED &&
    args.lastSummary !== undefined &&
    args.lastSummary.key_terms.length > 0
      ? ` ${args.lastSummary.key_terms.join(' ')}`
      : '';

  // recentContext for the synthesizer: rolling-summary prose at head (longest-
  // range memory), then recent finals excluding the current utterance (which IS
  // the query). Mirrors the prior in-pipeline construction.
  const recentContext: string[] = [];
  if (args.lastSummary !== undefined && args.lastSummary.summary.length > 0) {
    recentContext.push(args.lastSummary.summary);
  }
  for (const finalText of args.runtime.recentFinals.slice(0, -1)) {
    recentContext.push(finalText);
  }

  // ── PipelineInput (the source seam) ──────────────────────────────────
  const input: PipelineInput = {
    utteranceText: args.utteranceText,
    utteranceId: args.utteranceId,
    meetingId: args.meetingId,
    orgId: args.orgId,
    queryText: queryText + keyTermsBoost,
    lane,
    ...(recentContext.length > 0 ? { recentContext } : {}),
    ...(args.lastSummary !== undefined ? { lastSummary: args.lastSummary } : {}),
  };

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
    hybridSearch: (params) => hybridSearch(args.db, params),
    isLowConfidenceHits,
    optionalReranker,
    optionalQueryExpander,
    dedupeByDoc,
    expandWinnersToParents: (orgId, winners) => expandWinnersToParents(args.db, orgId, winners),
    parentDocEnabled,
    logger: args.logger,
    relevanceStrict: RELEVANCE_STRICT,
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
    ...(args.onGroundedAnswer !== undefined ? { onGroundedAnswer: args.onGroundedAnswer } : {}),
    ...(args.onSynthesisRequested !== undefined
      ? { onSynthesisRequested: args.onSynthesisRequested }
      : {}),
  });

  return runPipeline(input, deps, sink);
}
