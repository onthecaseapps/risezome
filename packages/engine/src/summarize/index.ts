// Public barrel for the rolling meeting summarizer module.
//
// The summarizer is a periodic side-call (every ~15 utterances or 120s
// debounced) that produces a structured snapshot of the meeting so far:
// prose summary, current_topic, open_questions, key_terms. Downstream
// consumers (synthesizer, relevance classifier, embedding-query
// expansion) read the result for long-range context.

export {
  type MeetingSummary,
  type Summarizer,
  type SummarizerInput,
  type SummarizerUsage,
  type SummarizerProviderErrorKind,
  SummarizerProviderError,
} from './contract.js';

export {
  AnthropicSummarizer,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicSummarizerOptions,
} from './anthropic.js';

export {
  buildSummarizerSystem,
  buildSummarizerTool,
  buildSummarizerUserMessage,
  parseSummarizerToolInput,
  type SystemBlock,
} from './prompt.js';
