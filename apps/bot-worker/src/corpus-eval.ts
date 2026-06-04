// Shared corpus-eval core: the deterministic scoring AND the per-question
// pipeline (embed -> hybrid search -> dedupe -> parent-expand -> synthesize ->
// verify -> score), returning rich intermediates. Lives in src/ (not eval/) so
// BOTH the CLI runner (eval/replay.ts) and the dev-page HTTP endpoints
// (src/index.ts) can use it without a build-time src->eval coupling.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VoyageEmbedder } from '@risezome/engine/embed';
import {
  type AnthropicSynthesizer,
  type CitationStatus,
} from '@risezome/engine/synthesize';
import { scoreRagas, type Judge, type RagasScores } from '@risezome/engine/eval';
import {
  type RelevanceClassifier,
  type RelevanceContext,
  classifySubstantiveQuestion,
} from '@risezome/engine/relevance';
import { hybridSearch } from './corpus-search.js';
import { optionalReranker } from './reranker.js';
import {
  expandWinnersToParents,
  parentDocEnabled,
  dedupeByDoc,
} from './parent-doc.js';
import { runPipeline } from './pipeline/core.js';
import { EvalCollectorSink } from './pipeline/sink-eval.js';
import type { PipelineDeps, PipelineInput, PipelineTrace } from './pipeline/contract.js';

// ── Golden set ──────────────────────────────────────────────────────────

/**
 * Precision-eval bucket. Drives precision / over-refusal scoring (U2):
 *  - `relevant`  — a genuine question about THIS repo's code/docs; SHOULD surface.
 *  - `offtopic`  — ordinary chit-chat / small talk; SHOULD suppress.
 *  - `adjacent`  — topically near the corpus but not actually about our stuff
 *                  (the hard negatives that leak today); SHOULD suppress.
 * Absent on a question ⇒ `relevant` (the original answerable golden set).
 */
export type EvalBucket = 'relevant' | 'offtopic' | 'adjacent';

/** One labeled question in eval/golden-questions.jsonl. */
export interface GoldenQuestion {
  /** The question as a meeting participant would phrase it. */
  readonly q: string;
  /** Which precision-eval bucket this belongs to (default `relevant`). */
  readonly bucket?: EvalBucket;
  /** Doc-id or title substrings expected among the retrieved docs
   *  (case-insensitive). INFORMATIONAL ONLY — feeds the reported `meanRecall`
   *  retrieval signal but does NOT gate pass/fail. */
  readonly must_surface?: readonly string[];
  /** Substrings the synthesized answer must contain (case-insensitive). */
  readonly expect_answer_contains?: readonly string[];
  /** When true, a refusal/suppression is the correct outcome. Implied for the
   *  `offtopic` and `adjacent` buckets. */
  readonly expect_refusal?: boolean;
  /** Optional free-text note for humans curating the set. */
  readonly note?: string;
}

/** The bucket a question belongs to, defaulting an absent tag to `relevant`. */
export function bucketOf(q: GoldenQuestion): EvalBucket {
  return q.bucket ?? 'relevant';
}

/** True when the correct outcome is suppression (no card) — the suppress buckets. */
export function expectsSuppression(q: GoldenQuestion): boolean {
  const bucket = bucketOf(q);
  return q.expect_refusal === true || bucket === 'offtopic' || bucket === 'adjacent';
}

/**
 * Lint the labeled set for internal consistency. Returns one message per
 * violation (empty ⇒ clean). Used by the dataset test so a mislabeled line
 * fails CI rather than silently skewing precision/over-refusal.
 */
export function validateGoldenSet(qs: readonly GoldenQuestion[]): string[] {
  const errors: string[] = [];
  qs.forEach((q, i) => {
    const where = `line ${String(i + 1)} (${q.q.slice(0, 48)})`;
    if (typeof q.q !== 'string' || q.q.trim().length === 0) {
      errors.push(`${where}: empty question`);
    }
    const bucket = bucketOf(q);
    if ((bucket === 'offtopic' || bucket === 'adjacent') && q.expect_refusal !== true) {
      errors.push(`${where}: ${bucket} must set expect_refusal:true`);
    }
    if (bucket === 'relevant' && q.expect_refusal === true) {
      errors.push(`${where}: relevant must not set expect_refusal:true`);
    }
    if (
      bucket === 'relevant' &&
      (q.expect_answer_contains === undefined || q.expect_answer_contains.length === 0) &&
      (q.must_surface === undefined || q.must_surface.length === 0)
    ) {
      errors.push(`${where}: relevant needs expect_answer_contains or must_surface`);
    }
  });
  return errors;
}

export function goldenFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'eval', 'golden-questions.jsonl');
}

export function loadGoldenSet(path: string = goldenFilePath()): GoldenQuestion[] {
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GoldenQuestion);
}

/** Append a golden question as one JSONL line. Throws on an empty `q`. */
export function appendGoldenQuestion(q: GoldenQuestion, path: string = goldenFilePath()): void {
  if (typeof q.q !== 'string' || q.q.trim().length === 0) {
    throw new Error('golden question requires a non-empty "q"');
  }
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}${JSON.stringify(q)}\n`);
}

// ── Scoring (pure) ──────────────────────────────────────────────────────

export interface RetrievedDoc {
  readonly chunkId: string;
  readonly docId: string;
  readonly title: string;
  readonly score: number;
}

export interface QuestionResult {
  readonly q: string;
  readonly retrieved: readonly RetrievedDoc[];
  readonly recall: number | null;
  readonly surfaced: readonly string[];
  readonly missed: readonly string[];
  readonly answer: string;
  readonly isRefusal: boolean;
  readonly answerContainsAll: boolean | null;
  readonly pass: boolean;
}

function norm(s: string): string {
  return s.toLowerCase();
}

/** must-surface label matches when any retrieved doc's id OR title contains it. */
export function computeRecall(
  retrieved: readonly RetrievedDoc[],
  mustSurface: readonly string[] | undefined,
): { recall: number | null; surfaced: string[]; missed: string[] } {
  if (mustSurface === undefined || mustSurface.length === 0) {
    return { recall: null, surfaced: [], missed: [] };
  }
  const haystack = retrieved.map((r) => `${norm(r.docId)} ${norm(r.title)}`);
  const surfaced: string[] = [];
  const missed: string[] = [];
  for (const label of mustSurface) {
    const needle = norm(label);
    if (haystack.some((h) => h.includes(needle))) surfaced.push(label);
    else missed.push(label);
  }
  return { recall: surfaced.length / mustSurface.length, surfaced, missed };
}

export function evaluateAnswer(
  answer: string,
  expectContains: readonly string[] | undefined,
): boolean | null {
  if (expectContains === undefined || expectContains.length === 0) return null;
  const a = norm(answer);
  return expectContains.every((s) => a.includes(norm(s)));
}

/**
 * Score one replayed question. Pass is driven by the END-TO-END answer:
 *  - expect_refusal questions pass iff the system refused (or suppressed).
 *  - otherwise: must NOT refuse, and every expected answer substring present.
 * `recall` over must_surface is reported (meanRecall) but does NOT gate.
 */
export function scoreQuestion(
  question: GoldenQuestion,
  retrieved: readonly RetrievedDoc[],
  answer: string,
  isRefusal: boolean,
): QuestionResult {
  const { recall, surfaced, missed } = computeRecall(retrieved, question.must_surface);
  const answerContainsAll = evaluateAnswer(answer, question.expect_answer_contains);
  const pass =
    question.expect_refusal === true ? isRefusal : !isRefusal && answerContainsAll !== false;
  return {
    q: question.q,
    retrieved,
    recall,
    surfaced,
    missed,
    answer,
    isRefusal,
    answerContainsAll,
    pass,
  };
}

export interface ReplaySummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  readonly meanRecall: number | null;
  readonly results: readonly QuestionResult[];
}

export function summarize(results: readonly QuestionResult[]): ReplaySummary {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const recalls = results.map((r) => r.recall).filter((r): r is number => r !== null);
  const meanRecall =
    recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total > 0 ? passed / total : 0,
    meanRecall,
    results,
  };
}

// ── Pipeline + rich intermediates ───────────────────────────────────────

const TOP_K = 5;
const silentLogger = { warn: () => undefined };

export interface EvalDeps {
  readonly db: SupabaseClient;
  readonly embedder: VoyageEmbedder;
  readonly synthesizer: AnthropicSynthesizer;
  readonly orgId: string;
  readonly judge: Judge | null;
  /**
   * Optional relevance gate. When set, evaluateQuestion runs the FULL real-time
   * path — heuristic gate → (ambiguous) LLM classifier → retrieval — mirroring
   * maybeRetrieveAndEmit, so suppression of off-topic/adjacent chatter is
   * measured where it happens. When null/absent, the gate is skipped
   * (retrieval-only, legacy behavior).
   */
  readonly relevanceClassifier?: RelevanceClassifier | null;
  /** Skip confidence required to honor a classifier `skip` (default 0.7). */
  readonly relevanceSkipThreshold?: number;
  /** Optional rolling-summary context for the classifier (omitted in eval). */
  readonly relevanceContext?: RelevanceContext;
  /**
   * Strict routing (U3): when true, route `clearly_substantive` utterances
   * through the LLM judge too (not just `ambiguous`), so the about-our-work
   * gate can fire on questions. Without this, substantive questions bypass the
   * judge and the strict prompt never sees them. Pairs with
   * RISEZOME_RELEVANCE_STRICT on the classifier.
   */
  readonly relevanceStrict?: boolean;
}

/** A source exactly as the synthesizer saw it, plus retrieval scores. */
export interface EvalSourceView {
  readonly rank: number;
  readonly docId: string;
  readonly title: string;
  readonly score: number;
  readonly distance: number | null;
  readonly ftsMatched: boolean;
  readonly position: number;
  /** The tight child excerpt that matched (U8 focus). */
  readonly focus: string;
  /** The (possibly expanded) text the synthesizer formulated from. */
  readonly text: string;
  /** Matched chunk is the doc's generated summary (U6). */
  readonly isSummary: boolean;
}

export interface EvalCitationView {
  readonly rank: number;
  readonly quote: string | null;
  readonly status: CitationStatus;
}

/**
 * Live triggering verdict for a question, computed from the SAME
 * classifySubstantiveQuestion the live adapter uses (R15) — so the eval mirrors
 * what live would do. `wouldFire` reflects the always-fire QUESTION lane;
 * dedup/ceiling are per-meeting stateful and not modeled in single-question
 * eval mode (KTD6).
 */
export interface TriggeringVerdict {
  readonly lane: 'question' | 'ambient';
  readonly isQuestion: boolean;
  /** The QUESTION lane fires this immediately (== isQuestion). Ambient
   *  utterances take the budgeted path, reflected by the gate/result below. */
  readonly wouldFire: boolean;
  readonly reason: string;
}

export function triggeringVerdictFor(question: string): TriggeringVerdict {
  const { isQuestion, reason } = classifySubstantiveQuestion(question);
  return { lane: isQuestion ? 'question' : 'ambient', isQuestion, wouldFire: isQuestion, reason };
}

/** Everything needed to render one row of the eval dev page. */
export interface EvalQuestionView {
  readonly question: GoldenQuestion;
  readonly result: QuestionResult;
  readonly sources: readonly EvalSourceView[];
  /** Raw synthesizer output, including the leading STATUS line. */
  readonly rawSynthesis: string;
  /** Parsed answer body (STATUS line stripped). */
  readonly answer: string;
  readonly isRefusal: boolean;
  /** Non-refusal answer whose citations all failed verification (hidden in prod). */
  readonly suppressed: boolean;
  readonly refusalReason: string | null;
  readonly citations: readonly EvalCitationView[];
  readonly droppedQuoted: number;
  readonly downgradedToBare: number;
  readonly ragas: RagasScores | null;
  /** Wall-clock ms for the full evaluated path (gate → retrieve → synthesize). */
  readonly latencyMs: number;
  /** True when the relevance gate suppressed the utterance before retrieval. */
  readonly gateSuppressed: boolean;
  /** Live two-lane triggering verdict (R14), from the shared classifier. */
  readonly triggeringVerdict: TriggeringVerdict;
  /** The per-stage pipeline trace for this question (the eval runs the shared
   *  core with a trace sink, so each evaluated question carries one). Null only
   *  if the core returned before assembling a trace. */
  readonly trace: PipelineTrace | null;
}

function emptyView(
  question: GoldenQuestion,
  reason: string,
  latencyMs: number,
  gateSuppressed = false,
  trace: PipelineTrace | null = null,
): EvalQuestionView {
  return {
    question,
    result: scoreQuestion(question, [], '', true),
    sources: [],
    rawSynthesis: '',
    answer: '',
    isRefusal: true,
    suppressed: false,
    refusalReason: reason,
    citations: [],
    droppedQuoted: 0,
    downgradedToBare: 0,
    ragas: null,
    latencyMs,
    gateSuppressed,
    triggeringVerdict: triggeringVerdictFor(question.q),
    trace,
  };
}

/**
 * Run one golden question through the SHARED pipeline core (the same
 * `runPipeline` prod + the dev sidecar run) with an in-memory collector sink,
 * then assemble the rich `EvalQuestionView` from the collected intermediates +
 * the existing scorer. This is U4's faithfulness gate: the eval now validates
 * prod by construction — there is no second copy of the retrieval/synthesis
 * stages here. The collector reproduces the exact surface/suppress + sources +
 * synthesis result the old hand-mirrored body did.
 */
export async function evaluateQuestion(
  deps: EvalDeps,
  question: GoldenQuestion,
): Promise<EvalQuestionView> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;

  const collector = new EvalCollectorSink();
  const input: PipelineInput = {
    // The eval's single golden question is BOTH the gated utterance and the
    // embedded/searched query (no rolling window — that's a prod source detail).
    utteranceText: question.q,
    queryText: question.q,
    utteranceId: `eval_${started.toString(36)}`,
    meetingId: 'eval',
    orgId: deps.orgId,
    ...(deps.relevanceContext !== undefined ? { relevanceContext: deps.relevanceContext } : {}),
  };

  // The same bot-worker search fns prod injects + the eval's embedder /
  // synthesizer / relevance judge. NO router/skills (the eval has none) and NO
  // CRAG (the old eval never expanded — `optionalQueryExpander` returns
  // undefined, so the core skips the CRAG stage), so behavior matches the old
  // pre-retrieval-gate path exactly.
  const pipelineDeps: PipelineDeps = {
    db: deps.db,
    embedder: deps.embedder,
    synthesizer: deps.synthesizer,
    ...(deps.relevanceClassifier != null ? { relevanceClassifier: deps.relevanceClassifier } : {}),
    hybridSearch: (params) =>
      hybridSearch(deps.db, {
        orgId: params.orgId,
        queryVectorLiteral: params.queryVectorLiteral,
        queryText: params.queryText,
        limit: params.limit,
        ...(params.reranker !== undefined ? { reranker: params.reranker } : {}),
        logger: params.logger ?? silentLogger,
      }),
    isLowConfidenceHits: () => false, // no CRAG in the eval (expander disabled below)
    optionalReranker,
    optionalQueryExpander: () => undefined, // CRAG off — matches the old eval path
    dedupeByDoc,
    expandWinnersToParents: (orgId, winners) => expandWinnersToParents(deps.db, orgId, winners),
    parentDocEnabled,
    logger: { info: () => undefined, warn: () => undefined },
    ...(deps.relevanceSkipThreshold !== undefined
      ? { relevanceSkipThreshold: deps.relevanceSkipThreshold }
      : {}),
    relevanceStrict: deps.relevanceStrict === true,
    topK: TOP_K,
  };

  await runPipeline(input, pipelineDeps, collector);

  const trace = collector.trace;

  // ── Gate short-circuit (the precision signal) ────────────────────────────
  // `recordSkip` fired ONLY when the relevance gate (heuristic-filler or judge
  // skip) stopped the utterance BEFORE retrieval — the exact `gateSuppressed`
  // semantics the old eval's `emptyView(..., true)` used.
  if (collector.skip !== null) {
    const reason =
      collector.skip.stage === 'heuristic-gate'
        ? 'relevance-gate: heuristic clearly_filler'
        : `relevance-gate: classifier skip (${(collector.skip.confidence ?? 0).toFixed(2)})`;
    return emptyView(question, reason, elapsed(), true, trace);
  }

  // ── Retrieval produced no sources (no hits / embed fail) ─────────────────
  // Not a gate suppression — the old eval returned an empty (refusal) view with
  // gateSuppressed:false here.
  if (collector.sources.length === 0) {
    const reason = collector.misses.some((m) => m.reason === 'no_hits')
      ? 'no retrieval hits'
      : 'no retrieval sources';
    return emptyView(question, reason, elapsed(), false, trace);
  }

  // ── Build the source + retrieved views from the collected cards ──────────
  const retrieved: RetrievedDoc[] = collector.sources.map((s) => ({
    chunkId: s.chunkId,
    docId: s.docId,
    title: s.title,
    score: s.score,
  }));
  const sourceViews: EvalSourceView[] = collector.sources.map((s) => ({
    rank: s.rank,
    docId: s.docId,
    title: s.title,
    score: s.score,
    distance: s.distance,
    ftsMatched: s.ftsMatched,
    position: s.position,
    focus: s.focus,
    text: s.text,
    isSummary: s.isSummary,
  }));

  // ── Synthesis outcome (refusal / ungrounded / grounded) ──────────────────
  const synth = collector.synthesis;
  const isRefusal = synth?.kind === 'refusal';
  const suppressed = synth?.kind === 'ungrounded';
  const effectiveRefusal = isRefusal || suppressed || synth === null;
  const answer = synth?.answer ?? '';
  const rawSynthesis = synth?.rawSynthesis ?? '';
  const details = synth?.citationDetails ?? [];

  let ragas: RagasScores | null = null;
  if (deps.judge !== null && !effectiveRefusal) {
    ragas = await scoreRagas(
      { question: question.q, answer, contexts: collector.sources.map((s) => s.text) },
      deps.judge,
    );
  }

  return {
    question,
    result: scoreQuestion(question, retrieved, answer, effectiveRefusal),
    sources: sourceViews,
    rawSynthesis,
    answer,
    isRefusal,
    suppressed,
    refusalReason: synth?.refusalReason ?? null,
    citations: details.map((d) => ({ rank: d.rank, quote: d.quote ?? null, status: d.status })),
    droppedQuoted: details.filter((d) => d.status === 'dropped').length,
    downgradedToBare: details.filter((d) => d.status === 'downgraded').length,
    ragas,
    latencyMs: elapsed(),
    gateSuppressed: false,
    triggeringVerdict: triggeringVerdictFor(question.q),
    trace,
  };
}

// ── Precision summary (U2) ──────────────────────────────────────────────

export interface BucketStat {
  readonly total: number;
  readonly surfaced: number;
  readonly suppressed: number;
  readonly passed: number;
}

export interface PrecisionSummary {
  /** Of the items that surfaced a card, the fraction that were `relevant`. */
  readonly precision: number | null;
  /** Of `relevant` items, the fraction wrongly suppressed (the guardrail). */
  readonly overRefusal: number | null;
  readonly surfacedTotal: number;
  readonly byBucket: Record<EvalBucket, BucketStat>;
  readonly latencyP50: number | null;
  readonly latencyP95: number | null;
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] ?? null;
}

/**
 * Precision / over-refusal / latency over a replayed set. "Surfaced" = a card
 * came out (not refused/suppressed). Precision is over surfaced items; over-
 * refusal is over the `relevant` bucket; latency p50/p95 are over all items.
 */
export function summarizePrecision(views: readonly EvalQuestionView[]): PrecisionSummary {
  const byBucket: Record<EvalBucket, { total: number; surfaced: number; passed: number }> = {
    relevant: { total: 0, surfaced: 0, passed: 0 },
    offtopic: { total: 0, surfaced: 0, passed: 0 },
    adjacent: { total: 0, surfaced: 0, passed: 0 },
  };
  for (const v of views) {
    const bucket = bucketOf(v.question);
    const surfaced = !v.result.isRefusal;
    byBucket[bucket].total += 1;
    if (surfaced) byBucket[bucket].surfaced += 1;
    if (v.result.pass) byBucket[bucket].passed += 1;
  }
  const surfacedTotal = byBucket.relevant.surfaced + byBucket.offtopic.surfaced + byBucket.adjacent.surfaced;
  const relevantTotal = byBucket.relevant.total;
  const latencies = views.map((v) => v.latencyMs).sort((a, b) => a - b);
  const mkStat = (b: { total: number; surfaced: number; passed: number }): BucketStat => ({
    total: b.total,
    surfaced: b.surfaced,
    suppressed: b.total - b.surfaced,
    passed: b.passed,
  });
  return {
    precision: surfacedTotal > 0 ? byBucket.relevant.surfaced / surfacedTotal : null,
    overRefusal:
      relevantTotal > 0 ? (relevantTotal - byBucket.relevant.surfaced) / relevantTotal : null,
    surfacedTotal,
    byBucket: {
      relevant: mkStat(byBucket.relevant),
      offtopic: mkStat(byBucket.offtopic),
      adjacent: mkStat(byBucket.adjacent),
    },
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
  };
}
