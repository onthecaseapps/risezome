import { describe, expect, it } from 'vitest';
import {
  buildSummarizerSystem,
  buildSummarizerTool,
  buildSummarizerUserMessage,
  parseSummarizerToolInput,
} from '../../src/summarize/prompt.js';
import type { MeetingSummary } from '../../src/summarize/contract.js';

describe('buildSummarizerSystem', () => {
  it('returns a single text block with ephemeral cache_control', () => {
    const blocks = buildSummarizerSystem();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('explains the four-field schema in the prompt', () => {
    const text = buildSummarizerSystem()[0]!.text;
    expect(text).toContain('summary');
    expect(text).toContain('current_topic');
    expect(text).toContain('open_questions');
    expect(text).toContain('key_terms');
  });

  it('instructs Claude to call the tool, not respond with text alone', () => {
    const text = buildSummarizerSystem()[0]!.text;
    expect(text).toMatch(/MUST call.*emit_meeting_summary/);
    expect(text).toMatch(/Do not respond with text alone/i);
  });

  it('explains the carry-forward instruction so prior_summary content survives transcript eviction', () => {
    const text = buildSummarizerSystem()[0]!.text;
    expect(text.toLowerCase()).toContain('carry-forward');
    expect(text).toMatch(/Preserve facts from the prior summary/i);
  });
});

describe('buildSummarizerTool', () => {
  it('defines emit_meeting_summary with all four required fields', () => {
    const tool = buildSummarizerTool();
    expect(tool.name).toBe('emit_meeting_summary');
    const schema = tool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required.sort()).toEqual(['current_topic', 'key_terms', 'open_questions', 'summary']);
    expect(schema.properties.summary).toBeDefined();
    expect(schema.properties.current_topic).toBeDefined();
    expect(schema.properties.open_questions).toBeDefined();
    expect(schema.properties.key_terms).toBeDefined();
  });
});

describe('buildSummarizerUserMessage', () => {
  it('renders just the transcript when no prior_summary is given', () => {
    const out = buildSummarizerUserMessage({
      transcript_window: 'A: hello world\nB: hi',
    });
    expect(out).toBe('Recent transcript:\nA: hello world\nB: hi');
  });

  it('prepends prior_summary as JSON above the transcript', () => {
    const prior: MeetingSummary = {
      summary: 'Earlier they discussed auth.',
      current_topic: 'auth flow',
      open_questions: ['How does SSO work?'],
      key_terms: ['Supabase', 'OAuth'],
    };
    const out = buildSummarizerUserMessage({
      transcript_window: 'Now talking about deploys.',
      prior_summary: prior,
    });
    expect(out).toContain('Prior summary (carry-forward source):');
    expect(out).toContain('"auth flow"');
    expect(out).toContain('"Supabase"');
    expect(out).toContain('Recent transcript:');
    expect(out).toContain('Now talking about deploys.');
    // Prior summary appears BEFORE the transcript
    expect(out.indexOf('Prior summary')).toBeLessThan(out.indexOf('Recent transcript'));
  });

  it('renders resolved_answers as a block above the transcript (close-the-loop)', () => {
    const out = buildSummarizerUserMessage({
      transcript_window: 'small talk about the weather',
      resolved_answers: ['The project uses Claude Haiku, Voyage, and Deepgram.'],
    });
    expect(out).toContain('Assistant answers already shown');
    expect(out).toContain('- The project uses Claude Haiku, Voyage, and Deepgram.');
    // Answers block precedes the transcript.
    expect(out.indexOf('Assistant answers already shown')).toBeLessThan(out.indexOf('Recent transcript'));
  });

  it('omits the resolved_answers block when the list is empty or absent', () => {
    expect(buildSummarizerUserMessage({ transcript_window: 't', resolved_answers: [] })).not.toContain(
      'Assistant answers already shown',
    );
    expect(buildSummarizerUserMessage({ transcript_window: 't' })).not.toContain('Assistant answers already shown');
  });
});

describe('parseSummarizerToolInput', () => {
  it('parses a well-formed tool_use input into a typed MeetingSummary', () => {
    const out = parseSummarizerToolInput({
      summary: 'The team discussed auth.',
      current_topic: 'auth flow',
      open_questions: ['How does SSO work?'],
      key_terms: ['Supabase', 'OAuth'],
    });
    expect(out).toEqual({
      summary: 'The team discussed auth.',
      current_topic: 'auth flow',
      open_questions: ['How does SSO work?'],
      key_terms: ['Supabase', 'OAuth'],
    });
  });

  it('accepts empty open_questions and key_terms arrays', () => {
    const out = parseSummarizerToolInput({
      summary: 'Nothing substantive yet.',
      current_topic: 'small talk',
      open_questions: [],
      key_terms: [],
    });
    expect(out.open_questions).toEqual([]);
    expect(out.key_terms).toEqual([]);
  });

  it('throws when summary is missing or wrong type', () => {
    expect(() =>
      parseSummarizerToolInput({
        current_topic: 'x',
        open_questions: [],
        key_terms: [],
      }),
    ).toThrow(/summary.*must be a string/);
  });

  it('throws when current_topic is wrong type', () => {
    expect(() =>
      parseSummarizerToolInput({
        summary: 'ok',
        current_topic: 42,
        open_questions: [],
        key_terms: [],
      }),
    ).toThrow(/current_topic.*must be a string/);
  });

  it('throws when open_questions contains a non-string element', () => {
    expect(() =>
      parseSummarizerToolInput({
        summary: 'ok',
        current_topic: 'x',
        open_questions: ['valid', 42],
        key_terms: [],
      }),
    ).toThrow(/open_questions.*string/);
  });

  it('throws when key_terms is not an array', () => {
    expect(() =>
      parseSummarizerToolInput({
        summary: 'ok',
        current_topic: 'x',
        open_questions: [],
        key_terms: 'not an array',
      }),
    ).toThrow(/key_terms.*string/);
  });
});
