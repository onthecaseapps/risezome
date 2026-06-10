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
  readonly batchDelayMs?: number;
  readonly onUsage?: (usage: VoyageUsage) => void;
  readonly onRetryWait?: (info: VoyageRetryWait) => void;
}

export interface VoyageRetryWait {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly waitMs: number;
  readonly reason: string;
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
const DEFAULT_MAX_RETRIES = 6;
/** Voyage caps a request at 128 inputs (and has per-request token limits);
 *  a whole domain group in one call fails wholesale past the cap. */
export const MAX_INPUTS_PER_REQUEST = 128;

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
  #lastCallEndTime: number | null = null;

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
      // Split the domain group into ≤128-input requests (Voyage's cap) and
      // stitch the vectors back in order — each response's `index` is
      // relative to its own request. Retry semantics stay per request
      // (#callVoyage handles 429/backoff for each batch independently).
      for (let offset = 0; offset < indices.length; offset += MAX_INPUTS_PER_REQUEST) {
        const batchIndices = indices.slice(offset, offset + MAX_INPUTS_PER_REQUEST);
        const texts = batchIndices.map((i) => req.items[i]!.text);
        const batch = await this.#callVoyage(texts, model);
        inputTokens += batch.usage?.total_tokens ?? 0;
        this.#options.onUsage?.({
          model,
          inputTokens: batch.usage?.total_tokens ?? 0,
          cacheHits: 0,
          providerCalls: 1,
        });
        for (const datum of batch.data) {
          const targetIdx = batchIndices[datum.index];
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
    const batchDelayMs = this.#options.batchDelayMs ?? 0;

    // Enforce a minimum interval between any two Voyage API calls, no matter
    // which embed() invocation they come from. This is what stays under
    // per-account 3 RPM / 10k TPM during bulk indexing where the CLI loops
    // make many separate embed() calls.
    if (batchDelayMs > 0 && this.#lastCallEndTime !== null) {
      const elapsed = Date.now() - this.#lastCallEndTime;
      const remaining = batchDelayMs - elapsed;
      if (remaining > 0) await sleep(remaining);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.#makeRequest(texts, model);
        this.#lastCallEndTime = Date.now();
        return result;
      } catch (err) {
        lastErr = err;
        if (err instanceof EmbeddingRateLimitError) {
          if (attempt < maxRetries - 1) {
            const waitMs = backoffMs(attempt, err.retryAfterMs);
            this.#options.onRetryWait?.({
              attempt: attempt + 1,
              maxRetries,
              waitMs,
              reason: err.message,
            });
            await sleep(waitMs);
            continue;
          }
        }
        if (err instanceof EmbeddingProviderError) {
          this.#lastCallEndTime = Date.now();
          throw err;
        }
        if (attempt >= maxRetries - 1) {
          this.#lastCallEndTime = Date.now();
          throw err;
        }
      }
    }
    this.#lastCallEndTime = Date.now();
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
      const retryAfterHeader = res.headers.get('retry-after');
      const parsed = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(parsed) ? parsed * 1000 : undefined;
      throw new EmbeddingRateLimitError(
        `Voyage returned 429 on model ${model} (Retry-After: ${retryAfterHeader ?? 'absent'})`,
        retryAfterMs,
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
  // If the server told us how long to wait (including 0 = retry immediately),
  // honour it with a small jitter so concurrent retrying clients don't sync.
  if (typeof retryAfterMs === 'number') {
    return retryAfterMs + Math.floor(Math.random() * 500);
  }
  // No Retry-After header: Voyage's free tier is per-minute, so a 2-second
  // cap was meaningless against a per-minute quota. Use 30s base on the first
  // retry with exponential growth up to ~60s plus jitter.
  const base = 30_000;
  const expo = Math.min(60_000, base * 2 ** Math.max(0, attempt - 1));
  return expo + Math.floor(Math.random() * 1500);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
