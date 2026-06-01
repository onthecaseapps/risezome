import { RisezomeError } from '@risezome/shared-types';
import type { SynthesisSource } from '../synthesize/contract.js';

/**
 * JSON Schema subset used for skill input_schema. Kept minimal so the
 * type stays portable across the Anthropic tool definition shape — the
 * schema is serialized verbatim into the request body.
 */
export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
}

export type JsonSchemaProperty =
  | { readonly type: 'string'; readonly description?: string; readonly enum?: readonly string[] }
  | { readonly type: 'integer'; readonly description?: string; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: 'boolean'; readonly description?: string }
  | { readonly type: 'array'; readonly description?: string; readonly items: JsonSchemaProperty };

/**
 * Stable shape of every skill result. The synthesizer consumes the
 * `summary` + (when present) the `items` list inside its source body;
 * `raw` is for telemetry and never crosses into the LLM prompt.
 */
export type SkillResultKind = 'count' | 'list' | 'detail';

export interface SkillResultItem {
  readonly title: string;
  readonly url?: string;
  readonly subtitle?: string;
}

export interface SkillResult {
  readonly kind: SkillResultKind;
  readonly summary: string;
  readonly items?: readonly SkillResultItem[];
  readonly raw?: unknown;
}

/**
 * Context passed to every skill handler. Diverges from the daemon's
 * SkillContext by two fields: `db` is the cloud Supabase client (not
 * better-sqlite3), and `orgId` is required for multi-tenant scoping.
 * Live-API skills ignore both; corpus skills depend on both.
 *
 * Typed as a minimal interface (not the full `SupabaseClient<Database>`
 * generic) so the engine package doesn't take a build-time dependency
 * on the consumer's generated database types. The duck-typed shape
 * here matches what every corpus skill uses: `.from(table)` + `.rpc(name, args)`.
 * Consumers pass the real `SupabaseClient` instance; the structural
 * subtype carries through.
 */
export interface SkillContext {
  readonly db: SkillDbClient;
  readonly orgId: string;
  /**
   * Forward-compatibility: skills receive an AbortSignal but most v1
   * skills don't poll it mid-query. The caller (pipeline) is
   * responsible for discarding the result when a newer flush has
   * aborted.
   */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/**
 * Minimal structural subset of `@supabase/supabase-js`'s SupabaseClient
 * that corpus skills actually use. Keeps the engine package free of a
 * direct Supabase dependency while still providing the type-safety the
 * skill handlers need.
 */
export interface SkillDbClient {
  from(table: string): unknown;
  rpc(fn: string, args?: Record<string, unknown>): unknown;
}

export interface Skill {
  /** Connector source the skill belongs to (e.g., 'github'). */
  readonly source: string;
  /** Fully qualified name passed to the classifier as the tool identifier (e.g., 'github_count'). */
  readonly name: string;
  /** Plain-English description shown to the classifier. Should be concise (1-2 sentences). */
  readonly description: string;
  /** JSON Schema for the skill's args; passed verbatim as the tool's `input_schema`. */
  readonly inputSchema: JsonSchema;
  /** Async handler. Args are pre-validated against inputSchema by Anthropic. */
  handler(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult>;
}

/**
 * Classifier picked a tool the registry doesn't have. Caller's
 * responsibility to fall back to RAG; the pipeline maps this to a
 * `skillFailed` event with code `unknown-skill`.
 */
export class SkillUnknownError extends RisezomeError {
  readonly skillName: string;
  constructor(skillName: string, options?: ErrorOptions) {
    super('skill-unknown', `Skill not registered: '${skillName}'`, options);
    this.skillName = skillName;
  }
}

/**
 * Telemetry-grade execution codes. Live skills set these to surface a
 * typed failure reason in the pipeline's `skillFailed` event. Corpus
 * skills can omit the code and inherit the `'execution-error'`
 * default — preserves existing telemetry.
 */
export type SkillExecutionCode =
  | 'execution-error'
  | 'rate-limit'
  | 'auth-error'
  | 'not-found'
  | 'unknown';

/**
 * Skill handler threw mid-execution. Distinct from SkillUnknownError so
 * the pipeline can log them with different telemetry codes. The shared
 * RisezomeError.code carries the error-class discriminator
 * ('skill-execution'); executionCode carries the telemetry signal that
 * flows into the pipeline's skillFailed event.
 */
export class SkillExecutionError extends RisezomeError {
  readonly skillName: string;
  readonly executionCode: SkillExecutionCode;
  constructor(
    skillName: string,
    message: string,
    options?: ErrorOptions & { executionCode?: SkillExecutionCode },
  ) {
    super('skill-execution', message, options);
    this.skillName = skillName;
    this.executionCode = options?.executionCode ?? 'execution-error';
  }
}

/**
 * Anthropic tool definition shape — what `toToolDefinitions()`
 * produces. Exposed here (not buried in the classifier) so registry
 * consumers can also build tool descriptors for future use cases.
 */
export interface AnthropicToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
}

/**
 * Convert a skill result into a SynthesisSource the synthesizer's
 * prompt already knows how to cite. The synthesizer cites by 1-indexed
 * position in the sources array, not by `rank` value — rank is here
 * for telemetry consistency. Tool sources always get `rank: 0` to
 * distinguish them in logs and traces from retrieval sources (which
 * have rank ≥ 1).
 *
 * The title carries the call signature so the user (and the
 * synthesizer's citation behavior) can see exactly which tool produced
 * the answer. The body is `summary` plus a numbered list of items
 * when present.
 *
 * This function is the load-bearing surface the synthesizer reads;
 * the corpus-skill rewrite (U6) locks its output byte-equal to the
 * daemon's via snapshot tests.
 */
export function formatAsSource(
  result: SkillResult,
  skillName: string,
  args: Record<string, unknown>,
): SynthesisSource {
  const argsJson = JSON.stringify(args);
  const title = `Tool: ${skillName}(${argsJson})`;
  const lines: string[] = [result.summary];
  if (result.items !== undefined && result.items.length > 0) {
    lines.push('');
    result.items.forEach((item, i) => {
      const idx = i + 1;
      const url = item.url !== undefined ? ` (${item.url})` : '';
      const subtitle = item.subtitle !== undefined ? ` — ${item.subtitle}` : '';
      lines.push(`#${String(idx)}: ${item.title}${subtitle}${url}`);
    });
  }
  return {
    rank: 0,
    title,
    text: lines.join('\n'),
  };
}
