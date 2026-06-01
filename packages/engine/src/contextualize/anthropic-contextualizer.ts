import type { ContextGenerator } from './contextualize.js';

// Production context generator. Puts the full source document in a
// `cache_control: ephemeral` block so successive chunk calls for the same
// document reuse it at the 90% cache discount (process a document's chunks
// back-to-back to stay inside the 5-minute cache window).

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 200;

const INSTRUCTION =
  'Give a short (1-2 sentence, under ~60 token) context that situates the following chunk within the document above, so it can be found by search on its own. State what part/section/file it is from and what it is about. Answer with the context only, no preamble.';

export interface AnthropicContextualizerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  readonly content?: { readonly type?: string; readonly text?: string }[];
}

export function makeAnthropicContextualizer(options: AnthropicContextualizerOptions): ContextGenerator {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (docText: string, chunkText: string): Promise<string> => {
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
        messages: [
          {
            role: 'user',
            content: [
              // Full document, cached so per-chunk calls reuse it.
              {
                type: 'text',
                text: `<document>\n${docText}\n</document>`,
                cache_control: { type: 'ephemeral' },
              },
              { type: 'text', text: `<chunk>\n${chunkText}\n</chunk>\n\n${INSTRUCTION}` },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) {
      throw new Error(`contextualizer request failed: ${String(resp.status)}`);
    }
    const json = (await resp.json()) as MessagesResponse;
    return (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  };
}
