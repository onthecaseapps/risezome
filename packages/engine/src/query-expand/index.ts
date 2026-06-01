// On-miss query expansion (CRAG fallback) for retrieval.

export { augmentQuery, type QueryExpander } from './query-expand.js';
export {
  makeAnthropicQueryExpander,
  type AnthropicQueryExpanderOptions,
} from './anthropic-query-expander.js';
