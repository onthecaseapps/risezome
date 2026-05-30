// Local regex classifier for "this utterance might be a tool query."
// Pure function, stateless, ~5 microseconds per call. Used by the pipeline
// to decide whether to spend the ~$0.001 + ~400 ms on a Claude classifier
// call. Misses are graceful: a false negative routes to plain RAG (the
// existing refusal path handles aggregation queries that slip through
// gracefully).
//
// CALLER CONTRACT: pass only the most-recent finalized utterance text, not
// a 30-second rolling window. The window may contain stale tool-shaped
// phrases from earlier in the meeting and trigger false positives that
// burn classifier cost on every flush. Stateless function does not enforce
// this — the pipeline is responsible.

// Phrase-fragment patterns covering the common aggregation/filter/list/
// temporal/author intents. Anchored on noun-phrase shapes so we don't
// trigger on "how does X work" or "what does Y mean" (RAG questions).
// Each pattern is lowercase against the lowercased input.
export const HEURISTIC_PATTERNS: readonly RegExp[] = [
  // Counting
  /\bhow many\b/,
  /\bcount\b/,
  // Listing
  /\blist (all|every|every|me|the)\b/,
  /\bshow (all|me all|every)\b/,
  /\bfind (all|every|me)\b/,
  // State queries
  /\bwhat('s| is) open\b/,
  /\bwhat('s| are) (open|closed|merged)\b/,
  /\bany open\b/,
  /\bare there any\b/,
  /\bis there (a|any)\b/,
  // Author queries
  /\bwho has\b/,
  /\bwho owns\b/,
  /\bassigned to\b/,
  /\bauthored by\b/,
  // Temporal
  /\brecently updated\b/,
  /\bupdated (this week|since|in the last)\b/,
  /\bchanged (since|this week|in the last)\b/,
  /\bwhat('s| is) new\b/,
];

export function isToolShaped(text: string): boolean {
  if (typeof text !== 'string') return false;
  const normalized = text.toLowerCase().trim();
  if (normalized.length === 0) return false;
  for (const pattern of HEURISTIC_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}
