import { RisezomeError } from '@risezome/shared-types';

/**
 * Discriminated result from the relevance classifier. `surface` carries no
 * confidence field — the contract is that "surface" is the default when the
 * model is uncertain (or when the call fails), so it's always implicitly
 * full confidence in the sense that no threshold gate applies. `skip`
 * carries the model's self-reported confidence which the pipeline checks
 * against RISEZOME_RELEVANCE_SKIP_THRESHOLD before honoring.
 */
export type RelevanceResult =
  | { readonly decision: 'surface' }
  | { readonly decision: 'skip'; readonly confidence: number; readonly reason: string };

export interface RelevanceClassifierUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

export interface RelevanceClassifier {
  classify(utterance: string, signal?: AbortSignal): Promise<RelevanceResult>;
}

// Mirrors ClassifierProviderError; same kind taxonomy because both classifiers
// hit the same Anthropic API and surface the same failure modes upstream.
export type RelevanceProviderErrorKind =
  | 'auth-error'
  | 'rate-limit'
  | 'bad-request'
  | 'network-error'
  | 'overloaded'
  | 'server-error'
  | 'timeout'
  | 'unknown';

export class RelevanceProviderError extends RisezomeError {
  readonly kind: RelevanceProviderErrorKind;
  readonly retryAfterMs: number | undefined;
  constructor(
    kind: RelevanceProviderErrorKind,
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super('relevance-provider', message, options);
    this.kind = kind;
    this.retryAfterMs = options?.retryAfterMs;
  }
}
