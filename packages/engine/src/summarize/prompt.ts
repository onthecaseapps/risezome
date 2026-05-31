// System prompt + tool schema for the rolling meeting summarizer.
// The summarizer fires on a pause-debounced cadence (every ~15
// utterances or 120s, whichever first) and produces a structured
// snapshot of the meeting so far: prose summary, current_topic,
// open_questions, key_terms.
//
// Tool-use enforces the four-field output shape — the model MUST call
// `emit_meeting_summary` and cannot respond with text alone. The
// parser scans the FULL content array for the tool_use block; the
// model sometimes emits a preamble text block before the tool call,
// and reading only content[0] would silently miss the structured
// output.
//
// Cache-control on the system block: the prompt is shorter than the
// 4096-token Haiku cache floor (this is intentional — the prompt is
// stable but small). Caching is best-effort; if the prefix doesn't
// reach the floor, calls just don't benefit from cached prefix on
// subsequent invocations. That's fine for the summarizer's per-meeting
// call volume (15-20 calls/hour).

import type { MeetingSummary, SummarizerInput } from './contract.js';

export interface SystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
}

const SYSTEM_INSTRUCTIONS = `You are the rolling meeting summarizer for Risezome, a real-time meeting-context copilot. Every couple minutes during a live meeting, you produce a structured snapshot of what has been discussed so far. Downstream components use your output to:

1. Give the synthesizer long-range topic context (so questions like "about that auth flow we were discussing" can be answered even when "auth flow" was mentioned 20 minutes ago).
2. Give the relevance classifier context for judging "does this utterance make sense to act on?" (so a fragment like "in the app and where in the code base are they" is recognized as a coherent continuation of the prior topic, not isolated filler).
3. Expand retrieval queries with project-specific vocabulary that has come up in the meeting (so short follow-ups still hit the right corpus chunks).

Your output is structured — call the emit_meeting_summary tool with all four fields. Do not respond with text alone.

Four-field output schema:

- summary: A 1-3 sentence prose paragraph covering what the meeting has been about so far. Lead with the dominant topic; mention important secondary threads briefly. Skip preamble ("This meeting has discussed..."). Write it as if continuing a description, not introducing one.

- current_topic: A short label (2-6 words) of the currently active thread. Examples: "Auth flow error handling", "Voyage embedding model selection", "Bot worker deployment to Fly.io". This is what the most recent utterances are about, not what the meeting started with.

- open_questions: An array of verbatim questions raised in the meeting but not yet resolved. Quote them as closely as the transcript allows. If no open questions, return an empty array. Limit to the 3-5 most recent unresolved questions.

- key_terms: An array of project-specific nouns the conversation has used: filenames (e.g., "apps/bot-worker/src/retrieval.ts"), identifiers (e.g., "U7", "PR #42"), library / service names (e.g., "Supabase", "Anthropic", "Voyage", "Recall"), domain concepts ("relevance classifier", "synthesis pipeline"). Skip generic words. Limit to 5-15 entries — the most distinctive ones.

CARRY-FORWARD: When the input includes a "Prior summary" block, treat it as historical context that may no longer appear in the "Recent transcript" window below it. Preserve facts from the prior summary that are still part of the meeting's arc; integrate new content from the recent transcript. The output should reflect the meeting's full duration, not just the last window. Resolve contradictions in favor of the more recent transcript content.

REFUSAL: If the transcript is empty or contains only filler with no substantive content, return all four fields with minimal content rather than refusing — empty open_questions and key_terms are fine; provide a short summary noting that nothing substantive has been discussed yet.

You MUST call the emit_meeting_summary tool. Do not respond with text alone.`;

const FEW_SHOT_EXAMPLE = `

EXAMPLE INPUT (no prior summary, fresh meeting):

Recent transcript:
"So we want to figure out what models are being used in the project.
Let me check.
I think we use Gemini.
Or maybe Claude.
Actually let me check the code base."

EXAMPLE OUTPUT (via emit_meeting_summary tool call):
{
  "summary": "The participants are trying to identify which AI models the project uses; initial guesses included Gemini and Claude but the speaker decided to check the code base for confirmation.",
  "current_topic": "AI models used in the project",
  "open_questions": ["What models are being used in the project?"],
  "key_terms": ["Gemini", "Claude"]
}

EXAMPLE INPUT (with prior summary — note carry-forward):

Prior summary:
{
  "summary": "Earlier the participants discussed the Risezome bot-worker's Recall.ai integration and the JWT handshake on the realtime WS endpoint.",
  "current_topic": "Recall.ai WS authentication",
  "open_questions": ["Does the JWT need to be rotated mid-meeting?"],
  "key_terms": ["Recall.ai", "JWT", "bot-worker", "realtime WS"]
}

Recent transcript:
"Anyway, let's talk about the summarizer now.
What cadence should it fire at?
Probably every couple minutes.
Or whenever there's a natural pause."

EXAMPLE OUTPUT (via emit_meeting_summary tool call):
{
  "summary": "Earlier the participants discussed the Risezome bot-worker's Recall.ai integration and JWT handshake; the conversation has now shifted to the rolling meeting summarizer's firing cadence, with a preference for periodic (every couple minutes) plus pause-triggered refreshes.",
  "current_topic": "Summarizer firing cadence",
  "open_questions": ["What cadence should the summarizer fire at?", "Does the JWT need to be rotated mid-meeting?"],
  "key_terms": ["Recall.ai", "JWT", "bot-worker", "summarizer", "pause-debounced cadence"]
}

Notice in the second example: the prior summary's Recall.ai/JWT context is PRESERVED in the new summary's prose and key_terms even though those topics don't appear in the recent transcript window. The carry-forward is what makes this useful for long meetings.`;

const FINAL_REMINDERS = `

FINAL REMINDERS:
- Call the emit_meeting_summary tool. Do not respond with text alone.
- All four fields are required. open_questions and key_terms can be empty arrays but not omitted.
- Carry forward facts from the prior summary that are still part of the meeting's arc.
- Keep summary terse (1-3 sentences). Keep current_topic short (2-6 words).
- key_terms are project-specific nouns, not generic words. Skip "feature", "system", "user" — those carry no retrieval signal.`;

const FULL_PROMPT = SYSTEM_INSTRUCTIONS + FEW_SHOT_EXAMPLE + FINAL_REMINDERS;

export function buildSummarizerSystem(): SystemBlock[] {
  return [
    {
      type: 'text',
      text: FULL_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Build the user-message string for a summarizer call. Includes the
 * prior summary (when present) above the recent transcript window so
 * Claude can perform the carry-forward.
 */
export function buildSummarizerUserMessage(input: SummarizerInput): string {
  const parts: string[] = [];
  if (input.prior_summary !== undefined) {
    parts.push('Prior summary (carry-forward source):');
    parts.push(JSON.stringify(input.prior_summary, null, 2));
    parts.push('');
  }
  parts.push('Recent transcript:');
  parts.push(input.transcript_window);
  return parts.join('\n');
}

/**
 * Tool definition. Schema requires all four fields. Anthropic enforces
 * tool-use input against this schema before the response reaches the
 * client, so missing-field cases fail server-side rather than at parse
 * time.
 */
export function buildSummarizerTool(): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  return {
    name: 'emit_meeting_summary',
    description:
      'Return the structured rolling meeting summary. Call this tool exactly once. All four fields are required; open_questions and key_terms may be empty arrays.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            '1-3 sentence prose paragraph covering the meeting\'s arc so far. Lead with the dominant topic; mention important secondary threads briefly.',
        },
        current_topic: {
          type: 'string',
          description:
            'Short label (2-6 words) of the currently active thread. What the most recent utterances are about.',
        },
        open_questions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Verbatim questions raised but not yet resolved. Limit 3-5 most recent. Empty array if none.',
        },
        key_terms: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Project-specific nouns: filenames, identifiers, library names, domain concepts. Limit 5-15 most distinctive. Empty array if none.',
        },
      },
      required: ['summary', 'current_topic', 'open_questions', 'key_terms'],
    },
  };
}

/**
 * Parse the tool_use input block into a typed MeetingSummary. Throws
 * on missing or wrong-typed fields (caller wraps in
 * SummarizerProviderError('bad-request')).
 */
export function parseSummarizerToolInput(input: Record<string, unknown>): MeetingSummary {
  const summary = input['summary'];
  const current_topic = input['current_topic'];
  const open_questions = input['open_questions'];
  const key_terms = input['key_terms'];

  if (typeof summary !== 'string') {
    throw new Error(`emit_meeting_summary: 'summary' must be a string; got ${typeof summary}`);
  }
  if (typeof current_topic !== 'string') {
    throw new Error(
      `emit_meeting_summary: 'current_topic' must be a string; got ${typeof current_topic}`,
    );
  }
  if (!Array.isArray(open_questions) || !open_questions.every((x) => typeof x === 'string')) {
    throw new Error(
      `emit_meeting_summary: 'open_questions' must be a string[]; got ${JSON.stringify(open_questions)}`,
    );
  }
  if (!Array.isArray(key_terms) || !key_terms.every((x) => typeof x === 'string')) {
    throw new Error(
      `emit_meeting_summary: 'key_terms' must be a string[]; got ${JSON.stringify(key_terms)}`,
    );
  }

  return {
    summary,
    current_topic,
    open_questions: open_questions as readonly string[],
    key_terms: key_terms as readonly string[],
  };
}
