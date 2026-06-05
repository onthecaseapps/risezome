/**
 * Whole-meeting AI recap. One non-streaming Claude call over the full
 * transcript, producing a STRUCTURED recap (overview / timestamped topics /
 * categorized decisions / action items with owner + timestamp) via Anthropic
 * forced tool-use — mirroring the relevance classifier's structured-output
 * pattern (packages/engine/src/relevance/anthropic-classifier.ts). The model
 * returns the narrative fields only; participants + speakerCount are DERIVED
 * from transcript speaker labels by the Inngest function, not asked of the
 * model. Kept self-contained with an injectable fetch so the function's logic
 * is unit-testable without a network.
 */

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
// Sized for a richer JSON object (timestamped topics + action items) — well
// above the old 700 that fit a short markdown blob, to avoid truncation.
const DEFAULT_MAX_TOKENS = 2000;
const RECAP_TOOL_NAME = 'meeting_recap';

const INSTRUCTION =
  'Recap the meeting transcript above by calling the meeting_recap tool exactly once. ' +
  'Produce: a one or two sentence plain-language overview; the key topics discussed; the ' +
  'decisions reached (each with a short topical category tag); and the action items (each ' +
  'naming the owner when stated). For each topic and action item, copy the [mm:ss] timestamp ' +
  'marker from the transcript line where it was discussed. Be specific and factual; do not ' +
  'invent anything not in the transcript. Omit any section that does not apply (return an empty list).';

export interface TranscriptLine {
  readonly speaker: string | null;
  readonly text: string;
  /** Milliseconds from meeting start; null when unknown (renders without a marker). */
  readonly startMs: number | null;
}

export interface RecapTopic {
  readonly text: string;
  readonly timestampMs: number | null;
}

export interface RecapDecision {
  readonly category: string;
  readonly text: string;
}

export interface RecapActionItem {
  readonly text: string;
  readonly assignee: string | null;
  readonly timestampMs: number | null;
}

/** Narrative fields the model produces. Participants/speakerCount are merged in by the caller. */
export interface StructuredRecapNarrative {
  readonly overview: string;
  readonly topics: readonly RecapTopic[];
  readonly decisions: readonly RecapDecision[];
  readonly action_items: readonly RecapActionItem[];
}

export interface RecapParticipant {
  readonly name: string;
}

/** The full persisted recap shape (narrative + derived participants/speakerCount). */
export interface StructuredRecap extends StructuredRecapNarrative {
  readonly participants: readonly RecapParticipant[];
  readonly speakerCount: number;
}

/** Thrown when the model response is wholly unusable (no tool_use block), so onFailure can fire. */
export class MeetingRecapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingRecapError';
  }
}

/** Format milliseconds-from-start as a `mm:ss` clock (minutes may exceed 59). */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Parse a `mm:ss` (or `hh:mm:ss`) clock string back to milliseconds; null if unparseable. */
function parseClockToMs(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let seconds: number;
  if (nums.length === 2) {
    seconds = nums[0]! * 60 + nums[1]!;
  } else {
    seconds = nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  }
  return Math.round(seconds * 1000);
}

/** Render ordered utterances into a timestamped, speaker-attributed transcript block. */
export function buildTranscriptText(lines: readonly TranscriptLine[]): string {
  return lines
    .map((l) => {
      const speaker = l.speaker !== null && l.speaker.length > 0 ? l.speaker : 'Unknown';
      const prefix = l.startMs !== null ? `[${formatClock(l.startMs)}] ` : '';
      return `${prefix}${speaker}: ${l.text}`;
    })
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

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface MessagesResponse {
  readonly content?: readonly ContentBlock[];
}

/** Tool definition for the Messages API request. The model must call it exactly once. */
function buildRecapTool(): { name: string; description: string; input_schema: Record<string, unknown> } {
  return {
    name: RECAP_TOOL_NAME,
    description:
      'Return the structured meeting recap. Call this exactly once with the overview, topics, ' +
      'decisions, and action items extracted from the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        overview: {
          type: 'string',
          description: 'A one or two sentence plain-language overview of the meeting.',
        },
        topics: {
          type: 'array',
          description: 'The key topics discussed, in order.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The topic, phrased as a short noun phrase or statement.' },
              timestamp: {
                type: 'string',
                description: 'The [mm:ss] marker from the transcript line where this topic began, e.g. "01:12". Omit if unclear.',
              },
            },
            required: ['text'],
          },
        },
        decisions: {
          type: 'array',
          description: 'The decisions reached.',
          items: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'A short (1-2 word) topical tag for the decision, e.g. "Schema" or "Pricing". Meeting-specific; not a fixed set.',
              },
              text: { type: 'string', description: 'The decision, stated factually.' },
            },
            required: ['text'],
          },
        },
        action_items: {
          type: 'array',
          description: 'The action items / follow-ups.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The action to be taken.' },
              assignee: {
                type: 'string',
                description: 'The name of the owner if stated in the transcript. Omit if no owner was named.',
              },
              timestamp: {
                type: 'string',
                description: 'The [mm:ss] marker from the transcript line where this action was raised, e.g. "05:00". Omit if unclear.',
              },
            },
            required: ['text'],
          },
        },
      },
      required: ['overview', 'topics', 'decisions', 'action_items'],
    },
  };
}

function toStringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseTopics(raw: unknown): RecapTopic[] {
  if (!Array.isArray(raw)) return [];
  const out: RecapTopic[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = toStringField(rec.text).trim();
    if (text.length === 0) continue;
    out.push({ text, timestampMs: parseClockToMs(rec.timestamp) });
  }
  return out;
}

function parseDecisions(raw: unknown): RecapDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: RecapDecision[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = toStringField(rec.text).trim();
    if (text.length === 0) continue;
    out.push({ category: toStringField(rec.category).trim(), text });
  }
  return out;
}

function parseActionItems(raw: unknown): RecapActionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RecapActionItem[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = toStringField(rec.text).trim();
    if (text.length === 0) continue;
    const assigneeRaw = toStringField(rec.assignee).trim();
    out.push({
      text,
      assignee: assigneeRaw.length > 0 ? assigneeRaw : null,
      timestampMs: parseClockToMs(rec.timestamp),
    });
  }
  return out;
}

/** Hand-validate the tool_use input into the typed narrative (coerce/skip malformed entries). */
function parseRecapToolInput(input: Record<string, unknown>): StructuredRecapNarrative {
  return {
    overview: toStringField(input.overview).trim(),
    topics: parseTopics(input.topics),
    decisions: parseDecisions(input.decisions),
    action_items: parseActionItems(input.action_items),
  };
}

export async function recapMeetingStructured(
  options: RecapMeetingOptions,
): Promise<StructuredRecapNarrative> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const tool = buildRecapTool();

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
      stream: false,
      tools: [tool],
      // Force the single tool so the model can't reply text-only; a text-only
      // response is a misbehavior we surface as MeetingRecapError below.
      tool_choice: { type: 'tool', name: tool.name },
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

  // Scan the FULL content array for the tool_use block (a preamble text block
  // before tool_use is possible; reading only content[0] would miss it).
  for (const block of json.content ?? []) {
    if (block.type === 'tool_use' && block.name === RECAP_TOOL_NAME) {
      return parseRecapToolInput(block.input ?? {});
    }
  }
  throw new MeetingRecapError('meeting recap response had no tool_use block; model returned text only');
}
