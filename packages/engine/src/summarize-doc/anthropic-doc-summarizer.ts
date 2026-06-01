import type { DocSummarizer } from './summarize-doc.js';

// Production document summarizer: one non-streaming Claude call per doc with
// the full document in a prompt-cached block (so it composes with the
// contextualizer's cache of the same doc within the 5-minute window).

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 256;

const INSTRUCTION =
  'Write a compact, fact-dense summary (2-4 sentences) of the document above. Lead with what it is and what it covers, then name the concrete, distinctive facts someone would search for (identifiers, names, versions, decisions, status). No preamble. Answer with the summary only.';

export interface AnthropicDocSummarizerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  readonly content?: { readonly type?: string; readonly text?: string }[];
}

export function makeAnthropicDocSummarizer(options: AnthropicDocSummarizerOptions): DocSummarizer {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  return async (docText: string, title: string): Promise<string> => {
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
              {
                type: 'text',
                text: `<document title="${title}">\n${docText}\n</document>`,
                cache_control: { type: 'ephemeral' },
              },
              { type: 'text', text: INSTRUCTION },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) {
      throw new Error(`doc summarizer request failed: ${String(resp.status)}`);
    }
    const json = (await resp.json()) as MessagesResponse;
    return (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  };
}
