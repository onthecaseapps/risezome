import { makeAnthropicQueryExpander, type QueryExpander } from '@risezome/engine/query-expand';

/**
 * Build the on-miss CRAG query expander (U9) from the environment, or
 * undefined when disabled. Gated by RISEZOME_CRAG_ENABLED (+ ANTHROPIC_API_KEY)
 * so it can be A/B'd; only ever invoked on a retrieval miss, so its cost is
 * bounded to hard queries.
 */
export function optionalQueryExpander(): QueryExpander | undefined {
  if (process.env.RISEZOME_CRAG_ENABLED !== 'true') return undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return makeAnthropicQueryExpander({ apiKey });
}
