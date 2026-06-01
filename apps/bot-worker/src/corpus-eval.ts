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
import { hybridSearch } from './corpus-search.js';
import { optionalReranker } from './reranker.js';
import { expandWinnersToParents, parentDocEnabled, dedupeByDoc, type WinningChunk } from './parent-doc.js';

// ── Golden set ──────────────────────────────────────────────────────────

/** One labeled question in eval/golden-questions.jsonl. */
export interface GoldenQuestion {
  /** The question as a meeting participant would phrase it. */
  readonly q: string;
  /** Doc-id or title substrings expected among the retrieved docs
   *  (case-insensitive). INFORMATIONAL ONLY — feeds the reported `meanRecall`
   *  retrieval signal but does NOT gate pass/fail. */
  readonly must_surface?: readonly string[];
  /** Substrings the synthesized answer must contain (case-insensitive). */
  readonly expect_answer_contains?: readonly string[];
  /** When true, a refusal is the correct outcome. */
  readonly expect_refusal?: boolean;
  /** Optional free-text note for humans curating the set. */
  readonly note?: string;
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
  const pass = question.expect_refusal === true ? isRefusal : !isRefusal && answerContainsAll !== false;
  return { q: question.q, retrieved, recall, surfaced, missed, answer, isRefusal, answerContainsAll, pass };
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
  const meanRecall = recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null;
  return { total, passed, failed: total - passed, passRate: total > 0 ? passed / total : 0, meanRecall, results };
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
}

function emptyView(question: GoldenQuestion, reason: string): EvalQuestionView {
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
  const embedResult = await deps.embedder.embed({ items: [{ text: question.q, domain: 'text' }] });
  const vec = embedResult.vectors[0]?.vector;
  if (vec === undefined) return emptyView(question, 'embed produced no vector');

  const hits = await hybridSearch(deps.db, {
    orgId: deps.orgId,
    queryVectorLiteral: `[${Array.from(vec).join(',')}]`,
    queryText: question.q,
    limit: TOP_K,
    reranker: optionalReranker(),
    logger: silentLogger,
  });
  if (hits.length === 0) return emptyView(question, 'no retrieval hits');

  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await deps.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, text, position')
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      { docId: c.doc_id as string, text: c.text as string, position: c.position as number },
    ]),
  );
  const docIds = [...new Set([...chunkById.values()].map((c) => c.docId))];
  const { data: docRows } = await deps.db.from('docs').select('id, title').in('id', docIds);
  const titleById = new Map((docRows ?? []).map((d) => [d.id as string, d.title as string]));

  // U8: collapse same-doc chunks to the best-ranked, then parent-expand.
  const sourceHits = parentDocEnabled()
    ? dedupeByDoc(hits, (h) => chunkById.get(h.chunk_id)?.docId)
    : hits;
  const winners: WinningChunk[] = sourceHits.flatMap((h) => {
    const c = chunkById.get(h.chunk_id);
    return c === undefined ? [] : [{ chunkId: h.chunk_id, docId: c.docId, position: c.position, text: c.text }];
  });
  const expandedByChunk = parentDocEnabled()
    ? await expandWinnersToParents(deps.db, winners)
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
  };
}
