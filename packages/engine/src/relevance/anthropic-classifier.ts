import {
  type ClassifyOptions,
  type RelevanceClassifier,
  type RelevanceClassifierUsage,
  type RelevanceResult,
  RelevanceProviderError,
  type RelevanceProviderErrorKind,
} from './contract.js';
import { buildRelevanceSystem, buildRelevanceTool, buildRelevanceUserMessage } from './prompt.js';

export interface AnthropicRelevanceClassifierOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly onUsage?: (usage: RelevanceClassifierUsage & { readonly model: string }) => void;
  readonly onRetryWait?: (info: {
    readonly attempt: number;
    readonly maxRetries: number;
    readonly waitMs: number;
    readonly reason: string;
  }) => void;
}

export const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_MAX_TOKENS = 200;
export const DEFAULT_TEMPERATURE = 0;
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
  readonly stop_reason?: string;
  readonly usage?: AnthropicUsage;
}

/**
 * Non-streaming Anthropic Messages call for the utterance-relevance pre-classifier.
 * Uses tool_use as a structured-output mechanism — the model is required to
 * call the should_surface tool exactly once. The response is parsed into a
 * RelevanceResult discriminated union and returned.
 *
 * Response parsing scans the FULL content array for any tool_use block
 * (not just content[0]); Anthropic can emit a text preamble + tool_use
 * together under tool_choice: 'auto'.
 *
 * Retry / abort / error taxonomy mirrors AnthropicClassifier (router).
 */
export class AnthropicRelevanceClassifier implements RelevanceClassifier {
  readonly #options: AnthropicRelevanceClassifierOptions;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #temperature: number;
  readonly #maxRetries: number;

  constructor(options: AnthropicRelevanceClassifierOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_ANTHROPIC_BASE;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async classify(utterance: string, options?: ClassifyOptions): Promise<RelevanceResult> {
    const response = await this.#postWithRetry(utterance, options);
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

    // Scan the FULL content array for any tool_use block. tool_choice 'auto'
    // can emit a preamble text block followed by tool_use; reading only
    // content[0] would silently misclassify those as the no-tool-found
    // branch.
    const content = json.content ?? [];
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        return parseRelevanceToolInput(block.input ?? {});
      }
    }
    throw new RelevanceProviderError(
      'bad-request',
      'Anthropic relevance classifier returned no tool_use block; model output text only',
    );
  }

  async #postWithRetry(utterance: string, options: ClassifyOptions | undefined): Promise<Response> {
    let attempt = 0;
    while (true) {
      let response: Response;
      try {
        response = await this.#postRequest(utterance, options);
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
        throw new RelevanceProviderError(
          'network-error',
          `Anthropic relevance classifier network error after ${String(attempt + 1)} attempts: ${(err as Error).message}`,
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
        throw new RelevanceProviderError(
          'rate-limit',
          `Anthropic relevance classifier 429 (Retry-After: ${response.headers.get('retry-after') ?? 'absent'})`,
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
        const kind: RelevanceProviderErrorKind =
          response.status === 529 ? 'overloaded' : 'server-error';
        throw new RelevanceProviderError(
          kind,
          `Anthropic relevance classifier ${String(response.status)} after ${String(attempt + 1)} attempts`,
        );
      }
      if (response.status === 401) {
        throw new RelevanceProviderError('auth-error', 'Anthropic relevance classifier 401: invalid API key');
      }
      if (response.status === 400) {
        const body = await safeReadText(response);
        throw new RelevanceProviderError('bad-request', `Anthropic relevance classifier 400: ${body}`);
      }
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new RelevanceProviderError(
          'unknown',
          `Anthropic relevance classifier ${String(response.status)}: ${body}`,
        );
      }
      return response;
    }
  }

  async #postRequest(utterance: string, options: ClassifyOptions | undefined): Promise<Response> {
    const url = `${this.#baseUrl.replace(/\/$/, '')}/v1/messages`;
    const userContent = buildRelevanceUserMessage(utterance, options?.context);
    const body = {
      model: this.#model,
      max_tokens: this.#maxTokens,
      temperature: this.#temperature,
      stream: false,
      system: buildRelevanceSystem(),
      tools: [buildRelevanceTool()],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: userContent }],
    };
    const signal = options?.signal;
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

function parseRelevanceToolInput(input: Record<string, unknown>): RelevanceResult {
  const decision = input.decision;
  if (decision === 'surface') return { decision: 'surface' };
  if (decision === 'skip') {
    const confidenceRaw = input.confidence;
    const reasonRaw = input.reason;
    const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : 0;
    const reason = typeof reasonRaw === 'string' ? reasonRaw : 'unspecified';
    return { decision: 'skip', confidence, reason };
  }
  throw new RelevanceProviderError(
    'bad-request',
    `Anthropic relevance classifier tool_use input had unknown decision value: ${JSON.stringify(decision)}`,
  );
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
