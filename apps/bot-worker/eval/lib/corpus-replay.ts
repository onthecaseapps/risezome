// Pure scoring core for the corpus eval harness (U1). The IO (embed →
// hybridSearch → enrich → synthesize) lives in ../replay.ts; this module is
// the deterministic logic worth unit-testing: recall against the labeled
// must-surface set and the per-question pass/fail decision.

/** One labeled question in eval/golden-questions.jsonl. */
export interface GoldenQuestion {
  /** The question as a meeting participant would phrase it. */
  readonly q: string;
  /** Doc-id or title substrings expected among the retrieved docs
   *  (case-insensitive). INFORMATIONAL ONLY — feeds the reported `meanRecall`
   *  retrieval signal but does NOT gate pass/fail. For a contextual-retrieval
   *  corpus many docs can legitimately answer a question, so "this exact file
   *  must surface" is too brittle to gate on; answer correctness
   *  (`expect_answer_contains`) is the gate, and RAGAS context-precision/recall
   *  measures retrieval quality. Omit when not tracking a retrieval target. */
  readonly must_surface?: readonly string[];
  /** Substrings the synthesized answer must contain (case-insensitive). */
  readonly expect_answer_contains?: readonly string[];
  /** When true, a refusal is the correct outcome (the corpus genuinely
   *  shouldn't answer). */
  readonly expect_refusal?: boolean;
  /** Optional free-text note for humans curating the set. */
  readonly note?: string;
}

/** A retrieved doc, enriched from a chunk hit by the runner. */
export interface RetrievedDoc {
  readonly chunkId: string;
  readonly docId: string;
  readonly title: string;
  readonly score: number;
}

export interface QuestionResult {
  readonly q: string;
  readonly retrieved: readonly RetrievedDoc[];
  /** Fraction of must_surface labels matched (0–1), or null when unlabeled. */
  readonly recall: number | null;
  readonly surfaced: readonly string[];
  readonly missed: readonly string[];
  readonly answer: string;
  readonly isRefusal: boolean;
  /** Whether every expect_answer_contains substring was present, or null. */
  readonly answerContainsAll: boolean | null;
  readonly pass: boolean;
}

function norm(s: string): string {
  return s.toLowerCase();
}

/** A must-surface label matches when any retrieved doc's id OR title contains
 *  it (case-insensitive substring). */
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

/** All expected substrings present in the answer (case-insensitive), or null
 *  when nothing was expected. */
export function evaluateAnswer(
  answer: string,
  expectContains: readonly string[] | undefined,
): boolean | null {
  if (expectContains === undefined || expectContains.length === 0) return null;
  const a = norm(answer);
  return expectContains.every((s) => a.includes(norm(s)));
}

/**
 * Score one replayed question. Pass is driven by the END-TO-END answer, not by
 * which docs retrieval surfaced:
 *  - expect_refusal questions pass iff the system refused.
 *  - otherwise: must NOT refuse, and every expected answer substring must be
 *    present (when labeled). An unlabeled answer that doesn't refuse passes.
 *
 * `recall` over must_surface is still computed and reported (meanRecall) as a
 * retrieval signal, but does NOT gate — a brittle keyword/file guess that
 * doesn't match a legitimately-different-but-correct retrieval used to
 * false-fail correct answers. Retrieval quality is measured by RAGAS
 * context-precision/recall instead.
 */
export function scoreQuestion(
  question: GoldenQuestion,
  retrieved: readonly RetrievedDoc[],
  answer: string,
  isRefusal: boolean,
): QuestionResult {
  const { recall, surfaced, missed } = computeRecall(retrieved, question.must_surface);
  const answerContainsAll = evaluateAnswer(answer, question.expect_answer_contains);

  let pass: boolean;
  if (question.expect_refusal === true) {
    pass = isRefusal;
  } else {
    pass = !isRefusal && answerContainsAll !== false;
  }

  return { q: question.q, retrieved, recall, surfaced, missed, answer, isRefusal, answerContainsAll, pass };
}

export interface ReplaySummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  /** Mean recall over questions that carry a must_surface set. */
  readonly meanRecall: number | null;
  readonly results: readonly QuestionResult[];
}

export function summarize(results: readonly QuestionResult[]): ReplaySummary {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const recalls = results.map((r) => r.recall).filter((r): r is number => r !== null);
  const meanRecall = recalls.length > 0 ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total > 0 ? passed / total : 0,
    meanRecall,
    results,
  };
}
