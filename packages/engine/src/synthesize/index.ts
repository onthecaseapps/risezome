// Synthesizer surface. Anthropic is the production implementation; the
// contract is provider-agnostic so a different LLM can be slotted in
// without changing the consumer.

export * from './contract.js';
export { AnthropicSynthesizer, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
export {
  parseSynthesisOutput,
  stripStatusPrefix,
  verifyCitations,
  verifyCitationsDetailed,
  citationsToRanks,
  REFUSAL_SENTINEL,
  STATUS_ANSWER,
  STATUS_NO_CONTEXT,
  buildSystemPrefix,
  buildUserMessage,
  type SystemBlock,
  type ParsedSynthesis,
  type ParsedCitation,
  type SynthesisStatus,
  type StatusGate,
  type CitationVerification,
  type CitationDetail,
  type CitationStatus,
} from './prompt.js';
