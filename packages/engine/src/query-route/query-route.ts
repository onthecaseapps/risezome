// Adaptive routing (U10): a fast, pure heuristic that classifies a query so
// the common case stays cheap. It gates the expensive on-miss CRAG expansion
// (U9): a substantive, scattered/thematic question is worth a re-retrieval
// when the first pass misses; a bare fragment or filler is not (expanding it
// just burns a call and risks noise).
//
// Pure + synchronous (<1ms), mirroring the heuristic-first gate the relevance
// and router classifiers already use. An LLM tier could be layered on later
// for genuinely ambiguous cases, but the heuristic covers the common ones.

export type QueryComplexity = 'simple' | 'scattered';

// Words that signal a query whose answer is likely spread across many docs
// (thematic / aggregate / overview), which benefits most from the rich path.
const SCATTERED_SIGNALS =
  /\b(all|every|across|list|overview|summary|architecture|which|what kind|how many|who|where .* (used|defined)|what .*\b(use|uses|using|used))\b/i;

/** Classify whether a query is a simple lookup or a scattered/thematic one. */
export function classifyQueryComplexity(query: string): QueryComplexity {
  const q = query.trim();
  const words = q.length === 0 ? 0 : q.split(/\s+/).length;
  if (SCATTERED_SIGNALS.test(q) || words >= 8) return 'scattered';
  return 'simple';
}

/**
 * Whether a first-pass retrieval MISS should trigger CRAG query expansion.
 * Skips pure filler / ultra-short fragments (nothing to expand usefully) and
 * trivially simple two-word lookups (a miss there is a genuine "not in the
 * corpus", not a vocabulary-mismatch problem expansion can fix).
 */
export function shouldExpandOnMiss(query: string): boolean {
  const words = query.trim().split(/\s+/).filter((w) => w.length > 0).length;
  if (words < 3) return false;
  return classifyQueryComplexity(query) === 'scattered' || words >= 5;
}
