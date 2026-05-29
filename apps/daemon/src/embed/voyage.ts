import {
  type EmbedRequest,
  type EmbedResult,
  type EmbedVector,
  type Embedder,
  type EmbeddingDomain,
  EmbeddingProviderError,
  EmbeddingRateLimitError,
} from './contract.js';
import { EmbedCache, contentHash } from './cache.js';

export interface VoyageOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly textModel?: string;
  readonly codeModel?: string;
  readonly dimension?: number;
  readonly fetchImpl?: typeof fetch;
  readonly cache?: EmbedCache;
  readonly maxRetries?: number;
  readonly onUsage?: (usage: VoyageUsage) => void;
}

export interface VoyageUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheHits: number;
  readonly providerCalls: number;
}

export const DEFAULT_VOYAGE_BASE = 'https://api.voyageai.com/v1';
export const DEFAULT_VOYAGE_TEXT_MODEL = 'voyage-3-large';
export const DEFAULT_VOYAGE_CODE_MODEL = 'voyage-code-3';
export const DEFAULT_VOYAGE_DIMENSION = 1024;
const DEFAULT_MAX_RETRIES = 3;

interface VoyageBatchResponse {
  readonly data: readonly { readonly index: number; readonly embedding: readonly number[] }[];
  readonly usage?: { readonly total_tokens?: number };
}

export class VoyageEmbedder implements Embedder {
  readonly #options: VoyageOptions;
  readonly #fetch: typeof fetch;
  readonly #cache: EmbedCache;
  readonly dimension: number;
  readonly #textModel: string;
  readonly #codeModel: string;

  constructor(options: VoyageOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#cache = options.cache ?? new EmbedCache();
    this.dimension = options.dimension ?? DEFAULT_VOYAGE_DIMENSION;
    this.#textModel = options.textModel ?? DEFAULT_VOYAGE_TEXT_MODEL;
    this.#codeModel = options.codeModel ?? DEFAULT_VOYAGE_CODE_MODEL;
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const vectors: EmbedVector[] = new Array<EmbedVector>(req.items.length);
    const byDomain = new Map<EmbeddingDomain, number[]>();
    let cacheHits = 0;

    req.items.forEach((item, index) => {
      const key = contentHash(item.text, item.domain);
      const cached = this.#cache.get(key);
      if (cached !== null) {
        vectors[index] = { index, vector: cached, cached: true };
        cacheHits += 1;
        return;
      }
      const list = byDomain.get(item.domain) ?? [];
      list.push(index);
      byDomain.set(item.domain, list);
    });

    let inputTokens = 0;
    for (const [domain, indices] of byDomain) {
      const model = this.#modelForDomain(domain);
      const texts = indices.map((i) => req.items[i]!.text);
      const batch = await this.#callVoyage(texts, model);
      inputTokens += batch.usage?.total_tokens ?? 0;
      this.#options.onUsage?.({
        model,
        inputTokens: batch.usage?.total_tokens ?? 0,
        cacheHits: 0,
        providerCalls: 1,
      });
      for (const datum of batch.data) {
        const targetIdx = indices[datum.index];
        if (targetIdx === undefined) continue;
        const vec = new Float32Array(datum.embedding);
        if (vec.length !== this.dimension) {
          throw new EmbeddingProviderError(
            `Voyage returned vector of length ${String(vec.length)}, expected ${String(this.dimension)}`,
          );
        }
        const item = req.items[targetIdx]!;
        const key = contentHash(item.text, item.domain);
        this.#cache.set(key, vec);
        vectors[targetIdx] = { index: targetIdx, vector: vec, cached: false };
      }
    }

    return {
      vectors,
      dimension: this.dimension,
      inputTokens,
      cacheHits,
    };
  }

  #modelForDomain(domain: EmbeddingDomain): string {
    return domain === 'code' ? this.#codeModel : this.#textModel;
  }

  async #callVoyage(texts: string[], model: string): Promise<VoyageBatchResponse> {
    const maxRetries = this.#options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.#makeRequest(texts, model);
      } catch (err) {
        lastErr = err;
        if (err instanceof EmbeddingRateLimitError) {
          if (attempt < maxRetries - 1) {
            await sleep(backoffMs(attempt, err.retryAfterMs));
            continue;
          }
        }
        if (err instanceof EmbeddingProviderError) {
          throw err;
        }
        if (attempt >= maxRetries - 1) throw err;
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new EmbeddingProviderError('Unknown Voyage error');
  }

  async #makeRequest(texts: string[], model: string): Promise<VoyageBatchResponse> {
    const baseUrl = this.#options.baseUrl ?? DEFAULT_VOYAGE_BASE;
    const url = new URL('embeddings', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.#options.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
        input_type: model.includes('code') ? 'document' : 'document',
      }),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      throw new EmbeddingRateLimitError(
        `Voyage returned 429 on model ${model}`,
        Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
      );
    }
    if (res.status >= 500) {
      const body = await safeReadText(res);
      throw new EmbeddingProviderError(`Voyage 5xx (${String(res.status)}): ${body}`);
    }
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new EmbeddingProviderError(`Voyage error (${String(res.status)}): ${body}`);
    }
    return (await res.json()) as VoyageBatchResponse;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) return retryAfterMs;
  return Math.min(2000, 200 * 2 ** attempt);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
