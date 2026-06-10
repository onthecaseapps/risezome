import { makeVoyageReranker, type Reranker } from '@risezome/engine/embed';

/**
 * Build the Voyage cross-encoder reranker (U4) from the environment, or
 * undefined when reranking isn't available. ON BY DEFAULT (the single biggest
 * precision lever, and it only needs VOYAGE_API_KEY, already required for
 * embeddings) — set RISEZOME_RERANK_ENABLED=false to opt out (e.g. an eval A/B).
 * The steering instruction nudges the ranker away from the keyword-dense
 * test/fixture files that pure RRF over-surfaces.
 */
export function optionalReranker(): Reranker | undefined {
  if (process.env.RISEZOME_RERANK_ENABLED === 'false') return undefined;
  const apiKey = process.env.VOYAGE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return makeVoyageReranker({
    apiKey,
    instruction:
      'Prefer documentation, plans, and application source that directly answers the query; deprioritize test files, fixtures, and snapshots.',
  });
}
