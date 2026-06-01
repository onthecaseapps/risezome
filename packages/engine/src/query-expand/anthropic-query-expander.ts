import type { QueryExpander } from './query-expand.js';

// Production query expander: one small Claude call returning candidate terms
// as JSON. Used only on a retrieval miss, so latency/cost is bounded.

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 200;

const INSTRUCTION =
  'A search over a knowledge base returned nothing for this question. List 6-12 specific terms that might appear in documents that DO answer it: concrete entity/product/model names (include plausible candidates even if not mentioned in the question), synonyms, and domain keywords. Respond ONLY with JSON: {"terms":["...","..."]}.';

export interface AnthropicQueryExpanderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  readonly content?: { readonly type?: string; readonly text?: string }[];
}

function parseTerms(text: string): string[] {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m === null) return [];
  try {
    const parsed = JSON.parse(m[0]) as { terms?: unknown };
    if (!Array.isArray(parsed.terms)) return [];
    return parsed.terms.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}

export function makeAnthropicQueryExpander(options: AnthropicQueryExpanderOptions): QueryExpander {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (query: string): Promise<string[]> => {
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
        messages: [{ role: 'user', content: `Question: ${query}\n\n${INSTRUCTION}` }],
      }),
    });
    if (!resp.ok) {
      throw new Error(`query expander request failed: ${String(resp.status)}`);
    }
    const json = (await resp.json()) as MessagesResponse;
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return parseTerms(text);
  };
}
