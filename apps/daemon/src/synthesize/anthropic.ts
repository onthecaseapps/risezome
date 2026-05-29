import { randomBytes } from 'node:crypto';
import {
  SynthesisProviderError,
  type SynthesisProviderErrorKind,
  SynthesisRateLimitError,
  type Synthesizer,
  type SynthesisChunk,
  type SynthesisInput,
  type SynthesisUsage,
} from './contract.js';
import { buildSystemBlocks, buildUserMessage, type SystemBlock } from './prompt.js';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly onUsage?: (usage: SynthesisUsage & { readonly model: string }) => void;
  readonly onRetryWait?: (info: {
    readonly attempt: number;
    readonly maxRetries: number;
    readonly waitMs: number;
    readonly reason: string;
  }) => void;
}

export const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_MAX_TOKENS = 150;
export const DEFAULT_TEMPERATURE = 0.2;
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_RETRIES = 4;

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface SseEvent {
  readonly eventType: string;
  readonly data: Record<string, unknown>;
}

export class AnthropicSynthesizer implements Synthesizer {
  readonly #options: AnthropicOptions;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #temperature: number;
  readonly #maxRetries: number;

  constructor(options: AnthropicOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_ANTHROPIC_BASE;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async *synthesize(input: SynthesisInput, signal?: AbortSignal): AsyncIterable<SynthesisChunk> {
    const synthesisId = `s_${randomBytes(6).toString('hex')}`;
    const response = await this.#connectWithRetry(input, signal);
    if (response.body === null) {
      throw new SynthesisProviderError('unknown', 'Anthropic response has no body');
    }
    yield* this.#streamChunks(response.body, synthesisId);
  }

  async #connectWithRetry(input: SynthesisInput, signal?: AbortSignal): Promise<Response> {
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
        throw new SynthesisProviderError(
          'network-error',
          `Anthropic network error after ${String(attempt + 1)} attempts: ${(err as Error).message}`,
        );
      }

      // Status-based handling. Retryable statuses cycle the loop; terminal
      // statuses throw a typed error; 2xx exits with the live response.
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
        throw new SynthesisRateLimitError(
          `Anthropic 429 (Retry-After: ${response.headers.get('retry-after') ?? 'absent'})`,
          retryAfterMs,
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
        const kind: SynthesisProviderErrorKind = response.status === 529 ? 'overloaded' : 'server-error';
        throw new SynthesisProviderError(
          kind,
          `Anthropic ${String(response.status)} after ${String(attempt + 1)} attempts`,
        );
      }
      if (response.status === 401) {
        throw new SynthesisProviderError('auth-error', 'Anthropic 401: invalid API key');
      }
      if (response.status === 400) {
        const body = await safeReadText(response);
        throw new SynthesisProviderError('bad-request', `Anthropic 400: ${body}`);
      }
      if (response.status === 413) {
        throw new SynthesisProviderError(
          'request-too-large',
          'Anthropic 413: request body exceeds 32MB',
        );
      }
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new SynthesisProviderError(
          'unknown',
          `Anthropic ${String(response.status)}: ${body}`,
        );
      }
      return response;
    }
  }

  async #postRequest(input: SynthesisInput, signal?: AbortSignal): Promise<Response> {
    const url = `${this.#baseUrl.replace(/\/$/, '')}/v1/messages`;
    const systemBlocks: SystemBlock[] = buildSystemBlocks();
    const userContent = buildUserMessage(input.utterance, input.sources);
    const body = {
      model: this.#model,
      max_tokens: input.maxTokens ?? this.#maxTokens,
      temperature: input.temperature ?? this.#temperature,
      stream: true,
      system: systemBlocks,
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

  async *#streamChunks(
    body: ReadableStream<Uint8Array>,
    synthesisId: string,
  ): AsyncIterable<SynthesisChunk> {
    let usage: SynthesisUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let stopReason = 'unknown';
    let model = this.#model;

    for await (const event of parseSseStream(body)) {
      switch (event.eventType) {
        case 'ping':
          continue;
        case 'message_start': {
          const msg = event.data['message'] as
            | { model?: string; usage?: AnthropicUsage }
            | undefined;
          if (msg?.usage !== undefined) usage = mergeUsage(usage, msg.usage);
          if (typeof msg?.model === 'string') model = msg.model;
          yield { type: 'start', synthesisId, model, usage };
          continue;
        }
        case 'content_block_delta': {
          const delta = event.data['delta'] as
            | { type?: string; text?: string }
            | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'textDelta', synthesisId, delta: delta.text };
          }
          continue;
        }
        case 'message_delta': {
          const usageDelta = event.data['usage'] as AnthropicUsage | undefined;
          if (usageDelta !== undefined) usage = mergeUsage(usage, usageDelta);
          const delta = event.data['delta'] as { stop_reason?: string } | undefined;
          if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
          continue;
        }
        case 'message_stop': {
          yield { type: 'done', synthesisId, stopReason, usage };
          this.#options.onUsage?.({ ...usage, model });
          return;
        }
        case 'error': {
          const errBody = event.data['error'] as
            | { type?: string; message?: string }
            | undefined;
          throw new SynthesisProviderError(
            mapMidStreamErrorKind(errBody?.type),
            errBody?.message ?? 'Anthropic mid-stream error',
          );
        }
        default:
          // content_block_start / content_block_stop / unknown — ignored.
          continue;
      }
    }
    // Stream ended without a `message_stop`. Treat as terminal error so the
    // pipeline can fall back to raw-cards-only.
    throw new SynthesisProviderError(
      'unknown',
      'Anthropic stream ended without message_stop',
    );
  }
}

function mergeUsage(
  existing: SynthesisUsage,
  incoming: AnthropicUsage,
): SynthesisUsage {
  return {
    inputTokens: incoming.input_tokens ?? existing.inputTokens,
    outputTokens: incoming.output_tokens ?? existing.outputTokens,
    cacheReadTokens: incoming.cache_read_input_tokens ?? existing.cacheReadTokens,
    cacheCreationTokens:
      incoming.cache_creation_input_tokens ?? existing.cacheCreationTokens,
  };
}

function mapMidStreamErrorKind(type: string | undefined): SynthesisProviderErrorKind {
  switch (type) {
    case 'overloaded_error':
      return 'overloaded';
    case 'api_error':
    case 'timeout_error':
      return 'server-error';
    case 'invalid_request_error':
      return 'bad-request';
    case 'authentication_error':
      return 'auth-error';
    default:
      return 'unknown';
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
    err instanceof DOMException
    && err.name === 'AbortError'
  ) || (err instanceof Error && err.name === 'AbortError');
}

// SSE parser: chunked Uint8Array → text → \n\n-separated event blocks.
// Each block is parsed into {eventType, data}. Pings, comments, and
// unparseable blocks are dropped silently.
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SseEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (ev !== null) yield ev;
      }
    }
    if (buffer.trim().length > 0) {
      const ev = parseSseBlock(buffer);
      if (ev !== null) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  let eventType: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const resolvedType =
    eventType ?? (typeof data['type'] === 'string' ? (data['type'] as string) : 'unknown');
  return { eventType: resolvedType, data };
}
