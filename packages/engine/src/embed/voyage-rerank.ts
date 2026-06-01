// Voyage rerank-2.5 cross-encoder reranker. Takes the candidate pool from
// hybrid search (vector + FTS + RRF) and reorders by joint query-document
// relevance — the single highest-ROI precision step after contextual
// retrieval. Instruction-steerable (e.g. "prefer application code and docs
// over tests").

const DEFAULT_RERANK_MODEL = 'rerank-2.5';
const DEFAULT_BASE = 'https://api.voyageai.com/v1';

export interface RerankResult {
  /** Index into the `documents` array passed to rerank. */
  readonly index: number;
  /** Relevance score (higher is better). */
  readonly score: number;
}

export interface RerankOptions {
  /** Keep at most this many results (after reordering). */
  readonly topK?: number;
}

/** Reorders documents by relevance to the query, best-first. */
export type Reranker = (
  query: string,
  documents: readonly string[],
  opts?: RerankOptions,
) => Promise<RerankResult[]>;

export interface VoyageRerankerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Steering instruction prepended to the query (rerank-2.5 supports this). */
  readonly instruction?: string;
}

interface VoyageRerankResponse {
  readonly data?: { readonly index?: number; readonly relevance_score?: number }[];
}

export function makeVoyageReranker(options: VoyageRerankerOptions): Reranker {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_RERANK_MODEL;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');

  return async (query, documents, opts): Promise<RerankResult[]> => {
    if (documents.length === 0) return [];
    const steered = options.instruction !== undefined ? `${options.instruction}\n\n${query}` : query;
    const resp = await fetchImpl(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        query: steered,
        documents,
        model,
        return_documents: false,
        ...(opts?.topK !== undefined ? { top_k: opts.topK } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`voyage rerank failed: ${String(resp.status)}`);
    }
    const json = (await resp.json()) as VoyageRerankResponse;
    return (json.data ?? [])
      .filter((r): r is { index: number; relevance_score: number } =>
        typeof r.index === 'number' && typeof r.relevance_score === 'number',
      )
      .map((r) => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => b.score - a.score);
  };
}
