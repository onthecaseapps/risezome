import { describe, it, expect } from 'vitest';
import { parseReplayInbound } from '../../src/debug/local-debug-ws';

describe('parseReplayInbound (U1 — transcript replay inbound)', () => {
  it('parses a replay-utterance into a finalized Utterance', () => {
    const out = parseReplayInbound(
      JSON.stringify({
        type: 'replay-utterance',
        utteranceId: 'u1',
        text: 'how many github issues are there',
        speaker: 'S0',
        startMs: 72_000,
      }),
    );
    expect(out).toEqual({
      kind: 'utterance',
      utterance: {
        utteranceId: 'u1',
        text: 'how many github issues are there',
        isFinal: true,
        speaker: 'S0',
        startMs: 72_000,
        endMs: 72_000,
        revision: 0,
      },
    });
  });

  it('trims surrounding whitespace from the text', () => {
    const out = parseReplayInbound(
      JSON.stringify({ type: 'replay-utterance', utteranceId: 'u2', text: '  hi there  ' }),
    );
    expect(out).toMatchObject({ kind: 'utterance', utterance: { text: 'hi there' } });
  });

  it('defaults startMs/endMs to 0 and omits speaker when absent', () => {
    const out = parseReplayInbound(JSON.stringify({ type: 'replay-utterance', utteranceId: 'u3', text: 'x' }));
    expect(out).toEqual({
      kind: 'utterance',
      utterance: { utteranceId: 'u3', text: 'x', isFinal: true, startMs: 0, endMs: 0, revision: 0 },
    });
  });

  it('parses a replay-reset with no meeting (unscoped)', () => {
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-reset' }))).toEqual({
      kind: 'reset',
      meetingId: null,
    });
  });

  it('parses a replay-reset carrying the real meeting id (scoped)', () => {
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-reset', meetingId: 'm-123' }))).toEqual({
      kind: 'reset',
      meetingId: 'm-123',
    });
  });

  it('treats an empty/blank meetingId on replay-reset as unscoped (null)', () => {
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-reset', meetingId: '' }))).toEqual({
      kind: 'reset',
      meetingId: null,
    });
  });

  it('drops a replay-utterance with empty/whitespace text (mirrors the live empty guard)', () => {
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-utterance', utteranceId: 'u', text: '   ' }))).toBeNull();
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-utterance', utteranceId: 'u', text: '' }))).toBeNull();
  });

  it('drops a replay-utterance missing a usable utteranceId', () => {
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-utterance', text: 'hi' }))).toBeNull();
    expect(parseReplayInbound(JSON.stringify({ type: 'replay-utterance', utteranceId: '', text: 'hi' }))).toBeNull();
  });

  it('returns null for malformed JSON, unknown types, and non-object frames', () => {
    expect(parseReplayInbound('{not json')).toBeNull();
    expect(parseReplayInbound(JSON.stringify({ type: 'utterance', text: 'hi' }))).toBeNull();
    expect(parseReplayInbound(JSON.stringify(5))).toBeNull();
    expect(parseReplayInbound(JSON.stringify(null))).toBeNull();
    expect(parseReplayInbound('')).toBeNull();
  });

  it('ignores a non-finite startMs and falls back to 0', () => {
    const out = parseReplayInbound(
      JSON.stringify({ type: 'replay-utterance', utteranceId: 'u', text: 'x', startMs: 'nope' }),
    );
    expect(out).toMatchObject({ utterance: { startMs: 0 } });
  });
});
