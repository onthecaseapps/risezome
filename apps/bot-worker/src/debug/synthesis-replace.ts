// Replace-vs-new decision for consecutive debug-page syntheses.
//
// When a new synthesis covers (largely) the same SOURCE DOCUMENTS as the one
// just shown, the page should replace that card in place rather than stack a
// near-duplicate — e.g. re-asking "what AI models are used" a few times should
// refine one card, not pile up several.
//
// The overlap MUST be measured over stable doc IDs, not the per-retrieval card
// IDs: each retrieval mints fresh `dbg_<uuid>` card IDs, so two retrievals of
// the very same documents share zero card IDs and a card-ID Jaccard is always
// 0 — which silently disabled replacement entirely (every synthesis stacked).

export const REPLACE_JACCARD_THRESHOLD = 0.5;
export const REPLACE_WINDOW_MS = 30_000;

export interface PriorSynthesis {
  readonly synthesisId: string;
  /** Stable source DOC ids the prior synthesis drew from (not card ids). */
  readonly sourceDocIds: readonly string[];
  readonly completedAt: number;
}

/** Jaccard overlap of two id sets (|A∩B| / |A∪B|), 0 when either is empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Should a new synthesis over `currentDocIds` replace the prior one in place?
 * True when the prior completed within REPLACE_WINDOW_MS AND the two cover the
 * same source docs by at least REPLACE_JACCARD_THRESHOLD overlap.
 */
export function shouldReplaceSynthesis(args: {
  readonly currentDocIds: readonly string[];
  readonly prior: PriorSynthesis | null;
  readonly now: number;
}): boolean {
  const { currentDocIds, prior, now } = args;
  if (prior === null) return false;
  if (now - prior.completedAt >= REPLACE_WINDOW_MS) return false;
  return jaccard(currentDocIds, prior.sourceDocIds) >= REPLACE_JACCARD_THRESHOLD;
}
