import { RisezomeError } from '@risezome/shared-types';

export type EmbeddingDomain = 'text' | 'code';

/** Voyage encodes queries and documents ASYMMETRICALLY (input_type) — using the
 *  document encoding for a search query measurably costs recall. Indexing embeds
 *  documents; retrieval embeds queries. Defaults to 'document' (the indexing
 *  path is the bulk caller and predates this field). */
export type EmbedPurpose = 'query' | 'document';

export interface EmbedItem {
  readonly text: string;
  readonly domain: EmbeddingDomain;
}

export interface EmbedRequest {
  readonly items: readonly EmbedItem[];
  /** 'query' for a search query, 'document' (default) for corpus content. */
  readonly purpose?: EmbedPurpose;
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

export class EmbeddingProviderError extends RisezomeError {
  constructor(message: string, options?: ErrorOptions) {
    super('embedding-provider', message, options);
  }
}

export class EmbeddingRateLimitError extends RisezomeError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number, options?: ErrorOptions) {
    super('embedding-rate-limit', message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

export class ConsentRequiredError extends RisezomeError {
  readonly providerId: string;
  constructor(providerId: string, options?: ErrorOptions) {
    super('consent-required', `Consent not granted for provider '${providerId}'.`, options);
    this.providerId = providerId;
  }
}
