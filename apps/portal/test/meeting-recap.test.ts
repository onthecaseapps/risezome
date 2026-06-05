import { describe, it, expect } from 'vitest';
import {
  buildTranscriptText,
  recapMeetingStructured,
  MeetingRecapError,
} from '../src/inngest/lib/meeting-recap';

describe('buildTranscriptText', () => {
  it('renders speaker-attributed lines with [mm:ss] timestamps when startMs is present', () => {
    const out = buildTranscriptText([
      { speaker: 'Alice', text: 'do we use AI', startMs: 72_000 },
      { speaker: 'Bob', text: 'yes, Claude', startMs: 220_000 },
    ]);
    expect(out).toBe('[01:12] Alice: do we use AI\n[03:40] Bob: yes, Claude');
  });

  it('labels a null/empty speaker as Unknown', () => {
    expect(buildTranscriptText([{ speaker: null, text: 'hi', startMs: 0 }])).toBe('[00:00] Unknown: hi');
    expect(buildTranscriptText([{ speaker: '', text: 'hi', startMs: 5_000 }])).toBe('[00:05] Unknown: hi');
  });

  it('omits the timestamp prefix when startMs is null', () => {
    expect(buildTranscriptText([{ speaker: 'Alice', text: 'hi', startMs: null }])).toBe('Alice: hi');
  });
});

describe('recapMeetingStructured', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function toolUseResponse(input: unknown): Response {
    return jsonResponse({ content: [{ type: 'tool_use', name: 'meeting_recap', input }] });
  }

  const fullInput = {
    overview: 'We discussed which AI models the product uses.',
    topics: [
      { text: 'AI model stack', timestamp: '01:12' },
      { text: 'Embeddings provider', timestamp: '03:40' },
    ],
    decisions: [{ category: 'Schema', text: 'Store recaps as structured JSON.' }],
    action_items: [{ text: 'Wire the regenerate button', assignee: 'Jason', timestamp: '05:00' }],
  };

  it('happy path: parses a tool_use block into the typed StructuredRecap, preserving timestamps', async () => {
    const fetchImpl: typeof fetch = (() => Promise.resolve(toolUseResponse(fullInput))) as typeof fetch;

    const recap = await recapMeetingStructured({
      transcriptText: '[01:12] Alice: do we use AI\n[03:40] Bob: yes, Claude',
      title: 'Standup',
      apiKey: 'sk-test',
      fetchImpl,
    });

    expect(recap.overview).toBe('We discussed which AI models the product uses.');
    expect(recap.topics).toEqual([
      { text: 'AI model stack', timestampMs: 72_000 },
      { text: 'Embeddings provider', timestampMs: 220_000 },
    ]);
    expect(recap.decisions).toEqual([{ category: 'Schema', text: 'Store recaps as structured JSON.' }]);
    expect(recap.action_items).toEqual([
      { text: 'Wire the regenerate button', assignee: 'Jason', timestampMs: 300_000 },
    ]);
  });

  it('sends a forced-tool-use request with a raised max_tokens and the timestamped transcript', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Promise.resolve(toolUseResponse(fullInput));
    }) as typeof fetch;

    await recapMeetingStructured({
      transcriptText: '[01:12] Alice: do we use AI',
      title: 'Standup',
      apiKey: 'sk-test',
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v1/messages');
    const body = calls[0]?.body as {
      max_tokens: number;
      tools: { name: string }[];
      tool_choice: { type: string; name: string };
      messages: { content: { text?: string }[] }[];
    };
    expect(body.tools[0]?.name).toBe('meeting_recap');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'meeting_recap' });
    expect(body.max_tokens).toBeGreaterThanOrEqual(2000);
    const userText = body.messages[0]?.content.map((c) => c.text ?? '').join(' ') ?? '';
    expect(userText).toContain('[01:12] Alice: do we use AI');
  });

  it('scans past a leading text block to find the tool_use block', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        jsonResponse({
          content: [
            { type: 'text', text: 'Here is the recap:' },
            { type: 'tool_use', name: 'meeting_recap', input: fullInput },
          ],
        }),
      )) as typeof fetch;
    const recap = await recapMeetingStructured({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl });
    expect(recap.overview).toBe('We discussed which AI models the product uses.');
  });

  it('coerces a missing/invalid timestamp to null and retains the item', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        toolUseResponse({
          overview: 'o',
          topics: [{ text: 'no timestamp' }, { text: 'bad timestamp', timestamp: 'not-a-clock' }],
          decisions: [],
          action_items: [{ text: 'do thing' }],
        }),
      )) as typeof fetch;
    const recap = await recapMeetingStructured({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl });
    expect(recap.topics).toEqual([
      { text: 'no timestamp', timestampMs: null },
      { text: 'bad timestamp', timestampMs: null },
    ]);
    expect(recap.action_items).toEqual([{ text: 'do thing', assignee: null, timestampMs: null }]);
  });

  it('retains a decision missing its category as an empty-string category', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        toolUseResponse({
          overview: 'o',
          topics: [],
          decisions: [{ text: 'untagged decision' }],
          action_items: [],
        }),
      )) as typeof fetch;
    const recap = await recapMeetingStructured({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl });
    expect(recap.decisions).toEqual([{ category: '', text: 'untagged decision' }]);
  });

  it('drops array entries that lack usable text', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        toolUseResponse({
          overview: 'o',
          topics: [{ text: '' }, { timestamp: '01:00' }, { text: 'kept' }],
          decisions: [{ category: 'X' }, { category: 'Y', text: 'kept decision' }],
          action_items: [{ assignee: 'Sam' }, { text: 'kept action' }],
        }),
      )) as typeof fetch;
    const recap = await recapMeetingStructured({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl });
    expect(recap.topics).toEqual([{ text: 'kept', timestampMs: null }]);
    expect(recap.decisions).toEqual([{ category: 'Y', text: 'kept decision' }]);
    expect(recap.action_items).toEqual([{ text: 'kept action', assignee: null, timestampMs: null }]);
  });

  it('throws MeetingRecapError when the response has no tool_use block (text-only)', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(jsonResponse({ content: [{ type: 'text', text: 'I could not produce a recap.' }] }))) as typeof fetch;
    await expect(
      recapMeetingStructured({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl }),
    ).rejects.toBeInstanceOf(MeetingRecapError);
  });

  it('throws when the Anthropic API returns a non-2xx', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(jsonResponse({ error: 'boom' }, 500))) as typeof fetch;
    await expect(
      recapMeetingStructured({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl }),
    ).rejects.toThrow(/recap request failed/i);
  });
});
