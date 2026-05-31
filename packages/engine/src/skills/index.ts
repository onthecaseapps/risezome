// Public barrel for the skill framework.
//
// Skills are structured-query handlers (e.g., "how many open issues?"
// → github_count). The classifier picks one per utterance; the
// pipeline dispatches via the registry and formats the result as a
// SynthesisSource the synthesizer cites alongside retrieval cards.

export {
  type Skill,
  type SkillContext,
  type SkillDbClient,
  type SkillResult,
  type SkillResultKind,
  type SkillResultItem,
  type SkillExecutionCode,
  type AnthropicToolDef,
  type JsonSchema,
  type JsonSchemaProperty,
  SkillUnknownError,
  SkillExecutionError,
  formatAsSource,
} from './contract.js';

export { SkillRegistry } from './registry.js';
