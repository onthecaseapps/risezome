/**
 * Knowledge Gaps — miss-capture decision (plan U3).
 *
 * AE6: only *substantive questions the copilot attempted and couldn't ground*
 * become gaps — filler the copilot never tried to answer must not.
 *
 * The `refusal` and `ungrounded` branches fire from inside synthesis, which
 * runs only AFTER the relevance gate has already passed — so those are always
 * recordable. The `no_hits` branch returns earlier in the pipeline, before the
 * relevance gate, so it must re-apply the cheap relevance heuristic here: a
 * `clearly_filler` utterance that happened to retrieve nothing is not a gap.
 */

import type { RelevanceHeuristicResult } from '../relevance/heuristic.js';
import type { MissReason } from './contract.js';

export function shouldRecordMiss(input: {
  reason: MissReason;
  /** The heuristic relevance of the utterance. Only consulted for `no_hits`. */
  relevance: RelevanceHeuristicResult;
}): boolean {
  if (input.reason === 'no_hits') {
    // The relevance gate hasn't run yet on this path — exclude obvious filler.
    return input.relevance !== 'clearly_filler';
  }
  // refusal / ungrounded already passed the relevance gate inside synthesis.
  return true;
}
