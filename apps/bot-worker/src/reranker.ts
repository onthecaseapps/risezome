import { makeVoyageReranker, type Reranker } from '@risezome/engine/embed';

/**
 * Build the Voyage cross-encoder reranker (U4) from the environment, or
 * undefined when reranking isn't enabled. Gated by RISEZOME_RERANK_ENABLED so
 * it can be A/B'd against the eval; needs VOYAGE_API_KEY (already required for
 * embeddings). The steering instruction nudges the ranker away from the
 * keyword-dense test/fixture files that pure RRF over-surfaces.
 */
export function optionalReranker(): Reranker | undefined {
  if (process.env.RISEZOME_RERANK_ENABLED !== 'true') return undefined;
  const apiKey = process.env.VOYAGE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return makeVoyageReranker({
    apiKey,
    instruction:
      'Prefer documentation, plans, and application source that directly answers the query; deprioritize test files, fixtures, and snapshots.',
  });
}
