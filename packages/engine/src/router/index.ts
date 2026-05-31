// Public barrel for the router classifier framework.
//
// The classifier picks between `tool` (a registered skill answers) and
// `rag` (the synthesizer runs over retrieved cards) per utterance.
// `isToolShaped` is the cheap regex gate that short-circuits the
// classifier for utterances that clearly aren't tool queries — saves
// the Anthropic call cost on ~60-80% of meeting speech.

export {
  type Classifier,
  type ClassifyInput,
  type ClassifyContext,
  type ClassifierResult,
  type ClassifierUsage,
  type ClassifierProviderErrorKind,
  ClassifierProviderError,
} from './contract.js';

export {
  AnthropicClassifier,
  DEFAULT_ANTHROPIC_BASE,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  ANTHROPIC_VERSION,
  type AnthropicClassifierOptions,
} from './anthropic-classifier.js';

export {
  buildClassifierSystem,
  buildClassifierUserMessage,
  CLASSIFIER_SYSTEM_PROMPT,
  HAIKU_CACHE_MIN_CHAR_PROXY,
  type SystemBlock,
  type ClassifierUserContext,
} from './prompt.js';

export { isToolShaped, HEURISTIC_PATTERNS } from './heuristic.js';
