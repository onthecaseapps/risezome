import { RisezomeError } from '@risezome/shared-types';
import type { SkillRegistry } from '../skills/registry.js';

/**
 * Optional meeting context the classifier can use to judge an utterance
 * against the conversation's established frame rather than in isolation.
 * When `current_topic` + `open_questions` are set, a short transcribed
 * fragment like "how many of those still open" reads as a tool query
 * about the prior topic rather than as filler.
 *
 * Both fields optional — callers with no rolling summary (cold start,
 * daemon path) omit them and get the legacy isolated-utterance
 * classification behavior.
 */
export interface ClassifyContext {
  readonly current_topic?: string;
  readonly open_questions?: readonly string[];
  /** Recent finalized turns (oldest first / most-recent last), the immediate
   *  anaphora antecedent. The rolling summary (`current_topic`) lags the live
   *  transcript, so a follow-up whose referent is one or two turns back ("how
   *  many of THESE issues") can't be resolved from the summary alone. Supplying
   *  the recent turns lets the classifier resolve the pronoun to the established
   *  entity and route to the right skill instead of falling back to RAG. */
  readonly recent_finals?: readonly string[];
}

export interface ClassifyInput {
  /** The single most-recent finalized utterance. NOT the 30s windowText. */
  readonly utterance: string;
  /** Skill registry whose toToolDefinitions() seeds the request's `tools` array. */
  readonly registry: SkillRegistry;
  /** Optional rolling-summary context. When provided, rendered as a
   *  meeting-context preamble in the user message. */
  readonly context?: ClassifyContext;
}

export type ClassifierResult =
  | { readonly intent: 'rag' }
  | { readonly intent: 'tool'; readonly skillName: string; readonly args: Record<string, unknown> };

export interface ClassifierUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface Classifier {
  classify(input: ClassifyInput, signal?: AbortSignal): Promise<ClassifierResult>;
}

// Discriminated taxonomy mirrors SynthesisProviderError exactly. Single class
// — 429s map to {kind: 'rate-limit', retryAfterMs?}, no separate subclass.
export type ClassifierProviderErrorKind =
  | 'auth-error'
  | 'rate-limit'
  | 'bad-request'
  | 'network-error'
  | 'overloaded'
  | 'server-error'
  | 'unknown';

export class ClassifierProviderError extends RisezomeError {
  readonly kind: ClassifierProviderErrorKind;
  readonly retryAfterMs: number | undefined;
  constructor(
    kind: ClassifierProviderErrorKind,
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super('classifier-provider', message, options);
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs;
  }
}
