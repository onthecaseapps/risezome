import { UpwellError } from '@upwell/shared-types';

export type EmbeddingDomain = 'text' | 'code';

export interface EmbedItem {
  readonly text: string;
  readonly domain: EmbeddingDomain;
}

export interface EmbedRequest {
  readonly items: readonly EmbedItem[];
}

export interface EmbedVector {
  readonly index: number;
  readonly vector: Float32Array;
  readonly cached: boolean;
}

export interface EmbedResult {
  readonly vectors: readonly EmbedVector[];
  readonly dimension: number;
  readonly inputTokens: number;
  readonly cacheHits: number;
}

export interface Embedder {
  readonly dimension: number;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

export class EmbeddingProviderError extends UpwellError {
  constructor(message: string, options?: ErrorOptions) {
    super('embedding-provider', message, options);
  }
}

export class EmbeddingRateLimitError extends UpwellError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, options?: ErrorOptions) {
    super('embedding-rate-limit', message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

export class ConsentRequiredError extends UpwellError {
  readonly providerId: string;
  constructor(providerId: string, options?: ErrorOptions) {
    super('consent-required', `Consent not granted for provider '${providerId}'.`, options);
    this.providerId = providerId;
  }
}
