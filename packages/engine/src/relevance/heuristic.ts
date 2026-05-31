// Local regex classifier for "is this utterance worth running the pipeline on."
// Pure stateless function. Returns a three-state result so the pipeline can:
//   - clearly_filler      → skip the pipeline entirely, log a skip line
//   - clearly_substantive → run the pipeline as today, no LLM check
//   - ambiguous           → fire the relevance LLM classifier (when wired)
//
// CALLER CONTRACT: pass only the most-recent finalized utterance text, not
// the rolling 30-second window. Stale text from earlier in the meeting can
// flip an obviously-filler utterance into ambiguous. The pipeline is
// responsible for sourcing latestFinalUtteranceText().

export type RelevanceHeuristicResult =
  | 'clearly_filler'
  | 'clearly_substantive'
  | 'ambiguous';

// Patterns that mark an utterance as clearly filler. Each regex tests the
// FULLY normalized utterance (lowercase + trimmed + trailing punctuation
// stripped). Anchored start-to-end where the whole utterance is the
// signal — partial matches are intentionally avoided because "yeah so the
// auth thing is broken" has a filler prefix but substantive content.
export const FILLER_PATTERNS: readonly RegExp[] = [
  // Single-word acknowledgments. Includes hummed and hesitation noises that
  // Deepgram sometimes emits as transcribed text.
  /^(yeah|yes|yep|nope|no|ok|okay|right|sure|sure thing|cool|nice|true|mm-?hm+|uh-?huh|hmm+|ah|oh|huh|alright|got it|fair)$/,
  // Stock filler phrases that are sometimes a full utterance on their own.
  /^(let me think|let's see|you know|i mean|i guess|i think so|i don't know|i'm not sure|that makes sense|good point|agreed|sounds good|exactly|totally)$/,
  // Social pleasantries.
  /^(hi|hello|hey|thanks|thank you|thanks a lot|cheers|bye|goodbye|see you|talk soon)$/,
  // Meta-meeting talk.
  /^(where were we|moving on|next item|next topic|next one|let's move on|let's continue|let's keep going)$/,
];

// Patterns that mark an utterance as clearly substantive. These bypass
// the LLM call entirely on the surface side — we never spend money on
// "definitely a real question" cases. Each tests the lowercased original
// (not the trailing-punctuation-stripped form) so we can see `?`.
export const SUBSTANTIVE_PATTERNS: readonly RegExp[] = [
  // Any question mark anywhere in the utterance.
  /\?/,
  // Starts with an interrogative word.
  /^(how|what|why|where|when|which|who|whose|whom|can|could|should|would|do|does|did|is|are|was|were|will|won't|don't|doesn't)\b/,
  // Starts with an imperative request form. Catches short substantive
  // requests that don't lead with an interrogative ("tell me about X",
  // "find issues by jamie").
  /^(tell me|show me|walk me through|explain|find|search|look up|pull up|remind me|i want to know|i need to)\b/,
  // Path-like tokens (slashes, colons, backslashes), file-extension words
  // (foo.ts, README.md), or backticks all imply a referenced identifier.
  /[/\\:]/,
  /\b\w+\.[a-z]{1,5}\b/,
  /`/,
];

// Length above which an utterance is treated as substantive regardless of
// pattern match. Long utterances are usually substantive — the known
// failure mode is long social filler ("oh wait no I totally hear you
// that was the same thing I was just thinking…"), acknowledged in the
// plan's Risks section.
export const SUBSTANTIVE_MIN_LENGTH = 80;

const MIN_LENGTH_FOR_NON_FILLER = 3;

// Strips trailing `.`, `!`, `?` (when used as terminal punctuation —
// callers asking the substantive branch see the original via the
// SUBSTANTIVE_PATTERNS check first), lowercases, and trims. Exported
// because MeetingSession's relevance cache key uses the same form so
// that "Yeah!", "yeah.", and "yeah" collide.
export function normalizeForRelevance(text: string): string {
  if (typeof text !== 'string') return '';
  const lower = text.toLowerCase().trim();
  // Strip terminal punctuation but only at the very end. Preserve `?` in
  // mid-sentence positions (handled by the substantive check before this
  // ever sees the question mark for a filler-vs-substantive decision).
  return lower.replace(/[.!?,;:]+$/, '').trim();
}

export function classifyRelevanceHeuristic(text: string): RelevanceHeuristicResult {
  if (typeof text !== 'string') return 'clearly_filler';
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return 'clearly_filler';
  // Filler patterns are checked BEFORE substantive patterns. Otherwise
  // "where were we" (meta-meeting filler) would be classified as
  // substantive on the strength of leading "where". Filler-first means
  // narrow whole-utterance matches win over broad start-of-utterance
  // interrogative matches.
  const normalized = normalizeForRelevance(text);
  if (normalized.length < MIN_LENGTH_FOR_NON_FILLER) return 'clearly_filler';
  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(normalized)) return 'clearly_filler';
  }
  // Substantive patterns checked against the lowercased (not normalized)
  // form so the `?` pattern can match a sentence ending in "?".
  if (lower.length >= SUBSTANTIVE_MIN_LENGTH) return 'clearly_substantive';
  for (const pattern of SUBSTANTIVE_PATTERNS) {
    if (pattern.test(lower)) return 'clearly_substantive';
  }
  return 'ambiguous';
}
