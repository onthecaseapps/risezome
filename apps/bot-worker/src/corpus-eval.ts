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
  parseSynthesisOutput,
  verifyCitationsDetailed,
  type AnthropicSynthesizer,
  type SynthesisSource,
  type CitationStatus,
} from '@risezome/engine/synthesize';
import { scoreRagas, type Judge, type RagasScores } from '@risezome/engine/eval';
import {
  classifyRelevanceHeuristic,
  type RelevanceClassifier,
  type RelevanceContext,
} from '@risezome/engine/relevance';
import { hybridSearch } from './corpus-search.js';
import { optionalReranker } from './reranker.js';
import {
  expandWinnersToParents,
  parentDocEnabled,
  dedupeByDoc,
  type WinningChunk,
} from './parent-doc.js';

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

const DEFAULT_RELEVANCE_SKIP_THRESHOLD = 0.7;

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
}

function emptyView(
  question: GoldenQuestion,
  reason: string,
  latencyMs: number,
  gateSuppressed = false,
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
  };
}

/**
 * Run one golden question through the real retrieval + synthesis path and
 * return rich intermediates for inspection + the scored result. Mirrors
 * apps/bot-worker/src/retrieval.ts (hybrid search, U8 dedupe + parent expand,
 * grounded-or-nothing) so the eval reflects production.
 */
export async function evaluateQuestion(
  deps: EvalDeps,
  question: GoldenQuestion,
): Promise<EvalQuestionView> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;

  // FULL real-time path: run the relevance gate before retrieval (mirrors
  // maybeRetrieveAndEmit). A gate skip = suppressed (no card) — correct for
  // offtopic/adjacent, an over-refusal for relevant. Only runs when a
  // classifier is wired; otherwise the heuristic still short-circuits filler.
  const heuristic = classifyRelevanceHeuristic(question.q);
  if (heuristic === 'clearly_filler') {
    return emptyView(question, 'relevance-gate: heuristic clearly_filler', elapsed(), true);
  }
  if (heuristic === 'ambiguous' && deps.relevanceClassifier != null) {
    const threshold = deps.relevanceSkipThreshold ?? DEFAULT_RELEVANCE_SKIP_THRESHOLD;
    let decision;
    try {
      decision = await deps.relevanceClassifier.classify(
        question.q,
        deps.relevanceContext !== undefined ? { context: deps.relevanceContext } : undefined,
      );
    } catch {
      decision = { decision: 'surface' as const }; // fail-open on classifier error
    }
    if (decision.decision === 'skip' && decision.confidence >= threshold) {
      return emptyView(
        question,
        `relevance-gate: classifier skip (${decision.confidence.toFixed(2)})`,
        elapsed(),
        true,
      );
    }
  }

  const embedResult = await deps.embedder.embed({ items: [{ text: question.q, domain: 'text' }] });
  const vec = embedResult.vectors[0]?.vector;
  if (vec === undefined) return emptyView(question, 'embed produced no vector', elapsed());

  const hits = await hybridSearch(deps.db, {
    orgId: deps.orgId,
    queryVectorLiteral: `[${Array.from(vec).join(',')}]`,
    queryText: question.q,
    limit: TOP_K,
    reranker: optionalReranker(),
    logger: silentLogger,
  });
  if (hits.length === 0) return emptyView(question, 'no retrieval hits', elapsed());

  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await deps.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, text, position, is_summary')
    .eq('org_id', deps.orgId) // U11: redundant org scope (defense-in-depth)
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      {
        docId: c.doc_id as string,
        text: c.text as string,
        position: c.position as number,
        isSummary: c.is_summary === true,
      },
    ]),
  );
  const docIds = [...new Set([...chunkById.values()].map((c) => c.docId))];
  const { data: docRows } = await deps.db
    .from('docs')
    .select('id, title')
    .eq('org_id', deps.orgId) // U11: redundant org scope (defense-in-depth)
    .in('id', docIds);
  const titleById = new Map((docRows ?? []).map((d) => [d.id as string, d.title as string]));

  // U8: collapse same-doc chunks to the best-ranked, then parent-expand.
  const sourceHits = parentDocEnabled()
    ? dedupeByDoc(hits, (h) => chunkById.get(h.chunk_id)?.docId)
    : hits;
  const winners: WinningChunk[] = sourceHits.flatMap((h) => {
    const c = chunkById.get(h.chunk_id);
    return c === undefined
      ? []
      : [{ chunkId: h.chunk_id, docId: c.docId, position: c.position, text: c.text }];
  });
  const expandedByChunk = parentDocEnabled()
    ? await expandWinnersToParents(deps.db, deps.orgId, winners)
    : new Map<string, string>();

  const retrieved: RetrievedDoc[] = [];
  const sources: SynthesisSource[] = [];
  const sourceViews: EvalSourceView[] = [];
  sourceHits.forEach((h, i) => {
    const chunk = chunkById.get(h.chunk_id);
    if (chunk === undefined) return;
    const title = titleById.get(chunk.docId) ?? chunk.docId;
    const text = expandedByChunk.get(h.chunk_id) ?? chunk.text;
    retrieved.push({ chunkId: h.chunk_id, docId: chunk.docId, title, score: h.score });
    sources.push({ rank: i + 1, title, text, focus: chunk.text, docId: chunk.docId });
    sourceViews.push({
      rank: i + 1,
      docId: chunk.docId,
      title,
      score: h.score,
      distance: h.distance,
      ftsMatched: h.ftsMatched,
      position: chunk.position,
      focus: chunk.text,
      text,
      isSummary: chunk.isSummary,
    });
  });

  let accumulated = '';
  for await (const chunk of deps.synthesizer.synthesize({ utterance: question.q, sources })) {
    if (chunk.type === 'textDelta') accumulated += chunk.delta;
  }
  const parsed = parseSynthesisOutput(accumulated, sources.length);
  const detail = verifyCitationsDetailed(parsed.citations, sources);
  const survivingCount = detail.filter((d) => d.status !== 'dropped').length;
  const suppressed = !parsed.isRefusal && survivingCount === 0;
  const effectiveRefusal = parsed.isRefusal || suppressed;

  let ragas: RagasScores | null = null;
  if (deps.judge !== null && !effectiveRefusal) {
    ragas = await scoreRagas(
      { question: question.q, answer: parsed.text, contexts: sources.map((s) => s.text) },
      deps.judge,
    );
  }

  return {
    question,
    result: scoreQuestion(question, retrieved, parsed.text, effectiveRefusal),
    sources: sourceViews,
    rawSynthesis: accumulated,
    answer: parsed.text,
    isRefusal: parsed.isRefusal,
    suppressed,
    refusalReason: parsed.refusalReason ?? null,
    citations: detail.map((d) => ({ rank: d.rank, quote: d.quote ?? null, status: d.status })),
    droppedQuoted: detail.filter((d) => d.status === 'dropped').length,
    downgradedToBare: detail.filter((d) => d.status === 'downgraded').length,
    ragas,
    latencyMs: elapsed(),
    gateSuppressed: false,
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
