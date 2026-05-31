// Synthesizer surface. Anthropic is the production implementation; the
// contract is provider-agnostic so a different LLM can be slotted in
// without changing the consumer.

export * from './contract.js';
export { AnthropicSynthesizer, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
export {
  parseSynthesisOutput,
  REFUSAL_SENTINEL,
  buildSystemPrefix,
  buildUserMessage,
  type SystemBlock,
  type ParsedSynthesis,
} from './prompt.js';
