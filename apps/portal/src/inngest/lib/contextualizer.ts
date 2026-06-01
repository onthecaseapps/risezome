import { makeAnthropicContextualizer, type ContextGenerator } from '@risezome/engine/contextualize';

/**
 * Build the contextual-retrieval generator (U3) from the environment, or
 * undefined when no Anthropic key is configured. Indexers pass the result to
 * their chunk-write path: when present, each chunk gets an LLM context
 * prepended to its embedded + lexically-indexed text; when absent, chunks
 * index body-only (prior behavior), so contextualization is opt-in by env.
 */
export function optionalContextGenerator(): ContextGenerator | undefined {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return undefined;
  return makeAnthropicContextualizer({ apiKey });
}
