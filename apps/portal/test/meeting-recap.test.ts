import { describe, it, expect } from 'vitest';
import { buildTranscriptText, recapMeeting } from '../src/inngest/lib/meeting-recap';

describe('buildTranscriptText', () => {
  it('renders speaker-attributed lines', () => {
    const out = buildTranscriptText([
      { speaker: 'Alice', text: 'do we use AI' },
      { speaker: 'Bob', text: 'yes, Claude' },
    ]);
    expect(out).toBe('Alice: do we use AI\nBob: yes, Claude');
  });

  it('labels a null/empty speaker as Unknown', () => {
    expect(buildTranscriptText([{ speaker: null, text: 'hi' }])).toBe('Unknown: hi');
    expect(buildTranscriptText([{ speaker: '', text: 'hi' }])).toBe('Unknown: hi');
  });
});

describe('recapMeeting', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  it('makes one Anthropic call with the transcript + returns the recap text', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(
        jsonResponse({ content: [{ type: 'text', text: '## Overview\nWe discussed AI.' }] }),
      );
    }) as typeof fetch;

    const recap = await recapMeeting({
      transcriptText: 'Alice: do we use AI\nBob: yes, Claude',
      title: 'Standup',
      apiKey: 'sk-test',
      fetchImpl,
    });

    expect(recap).toBe('## Overview\nWe discussed AI.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v1/messages');
    const body = calls[0]?.body as { messages: { content: { text?: string }[] }[] };
    const userText = body.messages[0]?.content.map((c) => c.text ?? '').join(' ') ?? '';
    expect(userText).toContain('Alice: do we use AI');
    expect(userText).toMatch(/Action items/i); // the instruction is included
  });

  it('throws when the Anthropic API returns a non-2xx', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(jsonResponse({ error: 'boom' }, 500))) as typeof fetch;
    await expect(
      recapMeeting({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl }),
    ).rejects.toThrow(/recap request failed/i);
  });

  it('joins multiple text blocks and trims', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        jsonResponse({ content: [{ type: 'text', text: '  part one ' }, { type: 'text', text: 'part two  ' }] }),
      )) as typeof fetch;
    const recap = await recapMeeting({ transcriptText: 't', title: 'm', apiKey: 'k', fetchImpl });
    expect(recap).toBe('part one part two');
  });
});
