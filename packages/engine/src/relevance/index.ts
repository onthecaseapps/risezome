// Relevance pre-classifier. The cheap heuristic returns a three-state
// result the caller uses to decide whether to spend on retrieval + LLM
// synthesis. The Anthropic-based LLM classifier (lifts later when
// needed) sits BEHIND the heuristic for ambiguous cases.

export * from './heuristic.js';
