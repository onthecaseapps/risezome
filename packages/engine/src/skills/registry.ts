import type { AnthropicToolDef, Skill } from './contract.js';

/**
 * Holds the union of skills across enabled connectors. Built once at
 * bot-worker startup; the classifier consumes `toToolDefinitions()`
 * per call to build the Anthropic tool list, and the pipeline consumes
 * `lookup(name)` to resolve a classifier-chosen skill back to its
 * handler.
 *
 * The registry intentionally has no per-call state — multiple meetings
 * can share the same instance. Mutations (register) happen at startup
 * only.
 */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  register(skill: Skill): void {
    if (this.#skills.has(skill.name)) {
      throw new Error(`SkillRegistry: duplicate skill name '${skill.name}'`);
    }
    this.#skills.set(skill.name, skill);
  }

  lookup(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  list(): readonly Skill[] {
    // Insertion order is preserved by Map iteration — registry
    // consumers can rely on stable ordering when building tool
    // definitions.
    return [...this.#skills.values()];
  }

  /**
   * Build the `tools` array for an Anthropic Messages request. Each
   * skill maps to `{name, description, input_schema}` — exactly what
   * Anthropic expects, no extra fields leak.
   */
  toToolDefinitions(): readonly AnthropicToolDef[] {
    return this.list().map((s) => ({
      name: s.name,
      description: s.description,
      input_schema: s.inputSchema,
    }));
  }

  size(): number {
    return this.#skills.size;
  }
}
