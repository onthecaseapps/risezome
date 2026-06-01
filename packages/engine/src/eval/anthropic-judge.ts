import type { Judge } from './ragas-metrics.js';

// Minimal non-streaming Anthropic Messages judge for the eval harness. Kept
// deliberately small (no retry/caching ceremony — eval runs offline, not in
// the live path); the metric core takes this as an injected `Judge`.

const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicJudgeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  readonly content?: { readonly type?: string; readonly text?: string }[];
}

/** Build a Judge backed by a non-streaming Claude Messages call at
 *  temperature 0 (deterministic scoring). */
export function makeAnthropicJudge(options: AnthropicJudgeOptions): Judge {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? 1024;

  return async (prompt: string): Promise<string> => {
    const resp = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      throw new Error(`judge request failed: ${String(resp.status)}`);
    }
    const json = (await resp.json()) as MessagesResponse;
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return text;
  };
}
