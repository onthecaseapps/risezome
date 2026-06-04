// "Is this utterance a genuine, answerable question?" — the QUESTION-lane
// signal for the live retrieval triggering policy. Pure, stateless, no I/O,
// so it is reused VERBATIM by both the live adapter (bot-worker retrieval) and
// the corpus eval, keeping the eval a faithful mirror of live behavior.
//
// This is distinct from classifyRelevanceHeuristic: that function's
// `clearly_substantive` fuses real questions with imperatives, filename
// mentions, and long statements, and the LLM relevance judge carries no
// question signal at all. So a clean "is a question" verdict needs its own
// derivation.
//
// CALLER CONTRACT (same as the heuristic): pass only the single most-recent
// finalized utterance, never the rolling window.
//
// Design choices:
//   - Interrogative-word START is the primary signal — live ASR (Deepgram)
//     routinely drops the trailing "?", so "what ai models do we use" must
//     read as a question with no punctuation.
//   - Info-seeking imperatives ("tell me…", "explain…", "find…") ARE
//     questions (the speaker wants an answer from the corpus). Action
//     commands ("open…", "close…") are NOT.
//   - Rhetorical tags ("right?", "you know?", "…makes sense, right?") are
//     NOT questions — stripped/detected before the interrogative test.
//   - Bare filename/path mentions are NOT questions (a statement referencing
//     a file is not a request for an answer).

import { classifyRelevanceHeuristic } from './heuristic.js';

export interface SubstantiveQuestionResult {
  /** True when the utterance is a genuine, answerable question. */
  readonly isQuestion: boolean;
  /** Short machine-ish reason, surfaced in the /debug/eval triggering verdict. */
  readonly reason: string;
}

// Interrogative openers (mirrors the heuristic's set; the `?`-anywhere pattern
// is intentionally NOT reused here — a `?` from a rhetorical tag must not count).
const INTERROGATIVE_START =
  /^(how|what|whats|what's|why|where|when|which|who|whose|whom|can|could|should|would|do|does|did|is|are|was|were|will|won'?t|don'?t|doesn'?t)\b/;

// Info-seeking imperatives — the speaker wants information back. Action
// imperatives (open/close/run/do/make) are deliberately excluded.
const INFO_IMPERATIVE_START =
  /^(tell me|show me|walk me through|explain|find|search|look up|pull up|remind me|i want to know|i'?d like to know|i need to know|i need to)\b/;

// Whole-utterance rhetorical questions (after terminal-punctuation strip).
const RHETORICAL_WHOLE =
  /^(right|you know|you know what i mean|you know what i'?m saying|isn'?t it|don'?t you think|wouldn'?t you say|makes sense|that makes sense|does that make sense|make sense)$/;

// Trailing rhetorical tag, optionally comma-led, optionally with a `?`.
// Stripped (repeatedly) before judging whether a real question remains.
const RHETORICAL_TAIL =
  /[\s,]*(right|you know( what i mean)?|yeah|ok|okay|no|huh|correct|isn'?t it|don'?t you think)\s*\??$/;

const MIN_QUESTION_WORDS = 2; // excludes one-word clarifications ("what?", "how?")

function stripTerminal(s: string): string {
  return s.replace(/[.!?,;:]+$/, '').trim();
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => w.length > 0).length;
}

export function classifySubstantiveQuestion(text: string): SubstantiveQuestionResult {
  if (typeof text !== 'string') return { isQuestion: false, reason: 'empty' };
  const lower = text.toLowerCase().trim();
  if (lower.length === 0) return { isQuestion: false, reason: 'empty' };

  // Filler short-circuits (acknowledgments, meta-meeting talk, standalone tags).
  if (classifyRelevanceHeuristic(text) === 'clearly_filler') {
    return { isQuestion: false, reason: 'filler' };
  }

  // Peel trailing rhetorical tags so a substantive statement that merely ends
  // in "…, right?" is not mistaken for a question on the strength of the `?`.
  let core = lower;
  for (let i = 0; i < 3 && RHETORICAL_TAIL.test(core); i++) {
    core = core.replace(RHETORICAL_TAIL, '').trim();
  }
  const coreNorm = stripTerminal(core);
  if (coreNorm.length === 0) return { isQuestion: false, reason: 'rhetorical' };
  if (RHETORICAL_WHOLE.test(coreNorm)) return { isQuestion: false, reason: 'rhetorical' };

  if (wordCount(coreNorm) < MIN_QUESTION_WORDS) {
    return { isQuestion: false, reason: 'too_short' };
  }

  if (INTERROGATIVE_START.test(coreNorm)) {
    return { isQuestion: true, reason: 'interrogative' };
  }
  if (INFO_IMPERATIVE_START.test(coreNorm)) {
    return { isQuestion: true, reason: 'info_request' };
  }
  // A genuine trailing `?` that survived rhetorical-tail stripping.
  if (core.endsWith('?')) {
    return { isQuestion: true, reason: 'question_mark' };
  }

  return { isQuestion: false, reason: 'not_a_question' };
}
