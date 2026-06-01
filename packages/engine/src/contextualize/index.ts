// Contextual Retrieval: per-chunk LLM context for the index-time enrichment
// step of the Claude-augmented RAG pipeline.

export {
  contextualizeChunks,
  contextualizedText,
  type ContextGenerator,
} from './contextualize.js';
export {
  makeAnthropicContextualizer,
  type AnthropicContextualizerOptions,
} from './anthropic-contextualizer.js';
