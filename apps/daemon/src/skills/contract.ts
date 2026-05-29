import { UpwellError } from '@upwell/shared-types';
import type { SynthesisSource } from '../synthesize/contract.js';

// JsonSchema subset we actually use for skill input_schema. Kept minimal so
// the type stays portable across the Anthropic tool definition shape — the
// schema is serialized verbatim into the request body.
export type JsonSchema = {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
};

export type JsonSchemaProperty =
  | { readonly type: 'string'; readonly description?: string; readonly enum?: readonly string[] }
  | { readonly type: 'integer'; readonly description?: string; readonly minimum?: number; readonly maximum?: number }
  | { readonly type: 'boolean'; readonly description?: string }
  | { readonly type: 'array'; readonly description?: string; readonly items: JsonSchemaProperty };

// Stable shape of every skill result. The synthesizer consumes the `summary`
// + (when present) the `items` list inside its source body; `raw` is for
// telemetry and never crosses into the LLM prompt.
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

export interface SkillContext {
  // The daemon's corpus DB. Skills run synchronous SQL through this handle —
  // they do not open or close it. The handle is shared with the retrieval
  // pipeline and lives for the full daemon process.
  readonly db: import('better-sqlite3').Database;
  // Forward-compatibility: skills receive an AbortSignal but v1 skills do not
  // poll it mid-query (better-sqlite3 is sync and short-running on the v1
  // corpus). The caller (pipeline) is responsible for discarding the result
  // when a newer flush has aborted.
  readonly signal?: AbortSignal;
  readonly now?: () => number;
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
  /** Synchronous-or-async handler. Args are pre-validated against inputSchema by Anthropic. */
  handler(args: Record<string, unknown>, ctx: SkillContext): Promise<SkillResult>;
}

// Classifier picked a tool the registry doesn't have. Caller's responsibility
// to fall back to RAG; the pipeline maps this to a `skillFailed` event.
export class SkillUnknownError extends UpwellError {
  readonly skillName: string;
  constructor(skillName: string, options?: ErrorOptions) {
    super('skill-unknown', `Skill not registered: '${skillName}'`, options);
    this.skillName = skillName;
  }
}

/**
 * Telemetry-grade execution codes. Live skills set these to surface a
 * typed failure reason in the pipeline's `skillFailed` event (and the
 * downstream serve.ts log line). Corpus skills can omit the code and
 * inherit the `'execution-error'` default — preserves existing telemetry.
 */
export type SkillExecutionCode =
  | 'execution-error'
  | 'rate-limit'
  | 'auth-error'
  | 'not-found'
  | 'unknown';

// Skill handler threw mid-execution. Distinct from SkillUnknownError so the
// pipeline can log them with different telemetry codes. The shared
// UpwellError.code carries the error-class discriminator
// ('skill-execution'); executionCode carries the telemetry signal that
// flows into the pipeline's skillFailed event.
export class SkillExecutionError extends UpwellError {
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

// Anthropic tool definition shape — what `toToolDefinitions()` produces.
// Exposed here (not buried in the classifier) so registry consumers can also
// build tool descriptors for future use cases like manual API surfaces.
export interface AnthropicToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
}

/**
 * Convert a skill result into a SynthesisSource the synthesizer's prompt
 * already knows how to cite. The synthesizer cites by 1-indexed position
 * in the sources array, not by `rank` value — rank is here for telemetry
 * consistency. Tool sources always get `rank: 0` to distinguish them in
 * logs and traces from retrieval sources (which have rank ≥ 1).
 *
 * The title carries the call signature so the user (and the synthesizer's
 * citation behavior) can see exactly which tool produced the answer. The
 * body is `summary` plus a numbered list of items when present.
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
