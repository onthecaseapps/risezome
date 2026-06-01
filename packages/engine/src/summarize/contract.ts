import { RisezomeError } from '@risezome/shared-types';

/**
 * The structured output of a rolling meeting summary call. Same shape
 * regardless of whether it's the first call (no prior_summary) or a
 * subsequent refresh (prior_summary carry-forward in the input).
 *
 * - `summary` — 1-3 sentence prose paragraph covering the meeting's
 *   arc so far. Consumed by the synthesizer as long-range topic
 *   context (prepended to recentContext).
 * - `current_topic` — short label of the active thread. Consumed by
 *   the relevance classifier so it can judge "does this utterance
 *   make sense as a continuation of this topic?"
 * - `open_questions` — verbatim questions raised but not yet
 *   resolved. Also consumed by the classifier for coherence-in-
 *   context judgment.
 * - `key_terms` — project-specific nouns (filenames, identifiers,
 *   plan U-IDs, library names) extracted from the conversation.
 *   Consumed by the embedding query (concatenated with the utterance)
 *   to boost retrieval recall for short follow-up utterances.
 */
export interface MeetingSummary {
  readonly summary: string;
  readonly current_topic: string;
  readonly open_questions: readonly string[];
  readonly key_terms: readonly string[];
}

/**
 * Input to a single summarizer call. The transcript_window is the
 * (capped) most-recent slice of the meeting transcript; prior_summary
 * is the result of the previous call (if any) used for carry-forward
 * of facts that have aged out of the transcript window.
 */
export interface SummarizerInput {
  readonly transcript_window: string;
  readonly prior_summary?: MeetingSummary;
  /**
   * Recent grounded answers the assistant has already shown on-screen (the AI
   * Summary), which are NOT spoken and so never appear in transcript_window.
   * Closing the loop: the summarizer treats any open question one of these
   * answers resolves as no longer open, so an answered question retires
   * instead of perpetually re-driving retrieval + synthesis. Most recent last.
   */
  readonly resolved_answers?: readonly string[];
}

export interface SummarizerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface Summarizer {
  summarize(input: SummarizerInput, signal?: AbortSignal): Promise<MeetingSummary>;
}

// Mirrors the relevance + synthesizer error taxonomy. Same Anthropic
// API, same failure modes.
export type SummarizerProviderErrorKind =
  | 'auth-error'
  | 'rate-limit'
  | 'bad-request'
  | 'network-error'
  | 'overloaded'
  | 'server-error'
  | 'timeout'
  | 'refused'
  | 'unknown';

export class SummarizerProviderError extends RisezomeError {
  readonly kind: SummarizerProviderErrorKind;
  readonly retryAfterMs: number | undefined;
  constructor(
    kind: SummarizerProviderErrorKind,
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super('summarizer-provider', message, options);
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs;
  }
}
