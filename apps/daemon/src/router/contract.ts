import { UpwellError } from '@upwell/shared-types';
import type { SkillRegistry } from '../skills/registry.js';

export interface ClassifyInput {
  /** The single most-recent finalized utterance. NOT the 30s windowText. */
  readonly utterance: string;
  /** Skill registry whose toToolDefinitions() seeds the request's `tools` array. */
  readonly registry: SkillRegistry;
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

export class ClassifierProviderError extends UpwellError {
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
