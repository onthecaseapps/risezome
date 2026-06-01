import {
  type MeetingSummary,
  type Summarizer,
  type SummarizerInput,
  type SummarizerProviderErrorKind,
  type SummarizerUsage,
  SummarizerProviderError,
} from './contract.js';
import {
  buildSummarizerSystem,
  buildSummarizerTool,
  buildSummarizerUserMessage,
  parseSummarizerToolInput,
  type SystemBlock,
} from './prompt.js';

/**
 * Anthropic implementation of the meeting summarizer. Mirrors the
 * `AnthropicRelevanceClassifier` constructor + retry shape — same
 * Anthropic API, same failure-mode taxonomy, same backoff. The
 * difference is tool name (`emit_meeting_summary`), schema (four
 * fields), and the user-message builder which includes the prior
 * summary as carry-forward context.
 *
 * The request forces `tool_choice: { type: 'tool', name:
 * 'emit_meeting_summary' }` so the model can't take the text-only
 * "refusal pathway". Output parsing still scans the FULL content array
 * (not just content[0]) as a defensive measure — cheap, and robust to any
 * preamble block.
 */

export interface AnthropicSummarizerOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly onUsage?: (usage: SummarizerUsage & { readonly model: string }) => void;
  readonly onRetryWait?: (info: {
    readonly attempt: number;
    readonly maxRetries: number;
    readonly waitMs: number;
    readonly reason: string;
  }) => void;
}

export const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_MAX_TOKENS = 600;
export const DEFAULT_TEMPERATURE = 0.2;
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_RETRIES = 4;

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface MessagesResponse {
  readonly id?: string;
  readonly model?: string;
  readonly content?: readonly ContentBlock[];
  readonly usage?: AnthropicUsage;
}

export class AnthropicSummarizer implements Summarizer {
  readonly #options: AnthropicSummarizerOptions;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #temperature: number;
  readonly #maxRetries: number;

  constructor(options: AnthropicSummarizerOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_ANTHROPIC_BASE;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async summarize(input: SummarizerInput, signal?: AbortSignal): Promise<MeetingSummary> {
    const response = await this.#postWithRetry(input, signal);
    const json = (await response.json()) as MessagesResponse;

    if (json.usage !== undefined) {
      this.#options.onUsage?.({
        model: json.model ?? this.#model,
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        cacheReadTokens: json.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: json.usage.cache_creation_input_tokens ?? 0,
      });
    }

    // Scan the FULL content array for the tool_use block — Anthropic
    // may emit a preamble text block before the tool_use.
    const content = json.content ?? [];
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        try {
          return parseSummarizerToolInput(block.input ?? {});
        } catch (err) {
          throw new SummarizerProviderError(
            'bad-request',
            `emit_meeting_summary tool_use input parse failed: ${(err as Error).message}`,
          );
        }
      }
    }
    throw new SummarizerProviderError(
      'refused',
      'Anthropic summarizer returned no tool_use block; model output text only (refusal pathway)',
    );
  }

  async #postWithRetry(
    input: SummarizerInput,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await this.#postRequest(input, signal);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (attempt < this.#maxRetries - 1) {
          const waitMs = backoffMs(attempt);
          this.#options.onRetryWait?.({
            attempt: attempt + 1,
            maxRetries: this.#maxRetries,
            waitMs,
            reason: `network: ${(err as Error).message}`,
          });
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        throw new SummarizerProviderError(
          'network-error',
          `Anthropic summarizer network error after ${String(attempt + 1)} attempts: ${(err as Error).message}`,
        );
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        if (attempt < this.#maxRetries - 1) {
          const waitMs = backoffMs(attempt, retryAfterMs);
          this.#options.onRetryWait?.({
            attempt: attempt + 1,
            maxRetries: this.#maxRetries,
            waitMs,
            reason: '429 rate-limited',
          });
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        throw new SummarizerProviderError(
          'rate-limit',
          `Anthropic summarizer 429 (Retry-After: ${response.headers.get('retry-after') ?? 'absent'})`,
          retryAfterMs !== undefined ? { retryAfterMs } : undefined,
        );
      }
      if (response.status === 529 || response.status >= 500) {
        if (attempt < this.#maxRetries - 1) {
          const waitMs = backoffMs(attempt);
          this.#options.onRetryWait?.({
            attempt: attempt + 1,
            maxRetries: this.#maxRetries,
            waitMs,
            reason: `${String(response.status)} transient`,
          });
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        const kind: SummarizerProviderErrorKind =
          response.status === 529 ? 'overloaded' : 'server-error';
        throw new SummarizerProviderError(
          kind,
          `Anthropic summarizer ${String(response.status)} after ${String(attempt + 1)} attempts`,
        );
      }
      if (response.status === 401) {
        throw new SummarizerProviderError('auth-error', 'Anthropic summarizer 401: invalid API key');
      }
      if (response.status === 400) {
        const body = await safeReadText(response);
        throw new SummarizerProviderError('bad-request', `Anthropic summarizer 400: ${body}`);
      }
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new SummarizerProviderError(
          'unknown',
          `Anthropic summarizer ${String(response.status)}: ${body}`,
        );
      }
      return response;
    }
  }

  async #postRequest(input: SummarizerInput, signal: AbortSignal | undefined): Promise<Response> {
    const url = `${this.#baseUrl.replace(/\/$/, '')}/v1/messages`;
    const systemBlocks: SystemBlock[] = buildSummarizerSystem();
    const userContent = buildSummarizerUserMessage(input);
    const tool = buildSummarizerTool();
    const body = {
      model: this.#model,
      max_tokens: this.#maxTokens,
      temperature: this.#temperature,
      stream: false,
      system: systemBlocks,
      tools: [tool],
      // FORCE the tool call. With tool_choice 'auto' the model could emit
      // plain text instead — the "refusal pathway" that throws downstream —
      // which happened intermittently on sparse/ambiguous transcript
      // windows despite the system prompt's "you MUST call the tool".
      // Forcing the specific tool guarantees a tool_use block; the prompt's
      // REFUSAL clause already yields minimal-content fields for an empty
      // window, which is the behavior we want over a thrown refusal.
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: userContent }],
    };
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': this.#options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    };
    return this.#fetch(url, init);
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const n = Number(header);
  if (!Number.isFinite(n)) return undefined;
  return n * 1000;
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === 'number') {
    return retryAfterMs + Math.floor(Math.random() * 250);
  }
  const base = 500;
  const expo = Math.min(30_000, base * 2 ** attempt);
  return expo + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
