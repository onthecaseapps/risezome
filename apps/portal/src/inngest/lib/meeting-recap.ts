/**
 * Whole-meeting AI recap (U7). One non-streaming Claude call over the full
 * transcript, producing a short markdown recap (overview / topics / decisions /
 * action items) for the review page. Kept self-contained — injectable fetch so
 * the Inngest function's logic is unit-testable without a network.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 700;

const INSTRUCTION =
  'You are recapping the meeting transcript above. Write a concise recap in markdown with these sections, omitting any that do not apply: a one or two sentence **Overview**, **Key topics** (bullets), **Decisions** (bullets), and **Action items** (bullets, name the owner when stated). Be specific and factual; do not invent anything not in the transcript. No preamble — output the recap only.';

export interface TranscriptLine {
  readonly speaker: string | null;
  readonly text: string;
}

/** Render ordered utterances into a speaker-attributed transcript block. */
export function buildTranscriptText(lines: readonly TranscriptLine[]): string {
  return lines
    .map((l) => `${l.speaker !== null && l.speaker.length > 0 ? l.speaker : 'Unknown'}: ${l.text}`)
    .join('\n');
}

export interface RecapMeetingOptions {
  readonly transcriptText: string;
  readonly title: string;
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetchImpl?: typeof fetch;
}

interface MessagesResponse {
  readonly content?: { readonly type?: string; readonly text?: string }[];
}

export async function recapMeeting(options: RecapMeetingOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

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
              text: `<transcript title="${options.title}">\n${options.transcriptText}\n</transcript>`,
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: INSTRUCTION },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`meeting recap request failed: ${String(resp.status)}`);
  }
  const json = (await resp.json()) as MessagesResponse;
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}
