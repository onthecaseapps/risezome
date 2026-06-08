import { describe, it, expect } from 'vitest';
import {
  parseTranscriptFile,
  toReplayUtterances,
} from '../../app/(authed)/debug/live-mic/_replay-source';
import type { TranscriptRow } from '../../app/_lib/transcript';

function row(over: Partial<TranscriptRow> & { payload: Record<string, unknown> | null }): TranscriptRow {
  return { event_id: 1, created_at: '2026-06-07T00:00:00Z', text: 'x', ...over } as TranscriptRow;
}

describe('toReplayUtterances (U2)', () => {
  it('maps rows to ordered utterances, sorted by startMs', () => {
    const out = toReplayUtterances([
      row({ text: 'second', payload: { utteranceId: 'b', speaker: 'S1', startMs: 5000 } }),
      row({ text: 'first', payload: { utteranceId: 'a', speaker: 'S0', startMs: 1000 } }),
    ]);
    expect(out).toEqual([
      { utteranceId: 'a', text: 'first', speaker: 'S0', startMs: 1000 },
      { utteranceId: 'b', text: 'second', speaker: 'S1', startMs: 5000 },
    ]);
  });

  it('drops rows missing text or utteranceId, and null-speaker/absent-startMs default cleanly', () => {
    const out = toReplayUtterances([
      row({ text: '', payload: { utteranceId: 'a', startMs: 0 } }),
      row({ text: 'kept', payload: { utteranceId: 'b' } }),
      row({ text: 'no-id', payload: { speaker: 'S0', startMs: 1 } }),
      row({ text: 'orphan', payload: null }),
    ]);
    expect(out).toEqual([{ utteranceId: 'b', text: 'kept', speaker: null, startMs: 0 }]);
  });
});

describe('parseTranscriptFile (U2)', () => {
  it('parses [mm:ss] Speaker: text lines (mm may exceed 59)', () => {
    const out = parseTranscriptFile('[00:00] S0: hello\n[01:12] S1: how many issues\n[72:05] S0: long meeting');
    expect(out).toEqual([
      { utteranceId: 'replay-0', text: 'hello', speaker: 'S0', startMs: 0 },
      { utteranceId: 'replay-1', text: 'how many issues', speaker: 'S1', startMs: 72_000 },
      { utteranceId: 'replay-2', text: 'long meeting', speaker: 'S0', startMs: 72 * 60 * 1000 + 5000 },
    ]);
  });

  it('handles lines without a speaker', () => {
    expect(parseTranscriptFile('[00:03] just text')).toEqual([
      { utteranceId: 'replay-0', text: 'just text', speaker: null, startMs: 3000 },
    ]);
  });

  it('skips non-matching lines (id reflects the source line index), keeps order by startMs', () => {
    const out = parseTranscriptFile('garbage line\n[00:01] S0: real\n\n# comment');
    expect(out).toEqual([{ utteranceId: 'replay-1', text: 'real', speaker: 'S0', startMs: 1000 }]);
  });

  it('parses a JSON array of utterance objects, sorted + defaulted', () => {
    const out = parseTranscriptFile(
      JSON.stringify([
        { text: 'b', startMs: 2000, speaker: 'S1', utteranceId: 'x' },
        { text: 'a', startMs: 500 },
      ]),
    );
    expect(out).toEqual([
      { utteranceId: 'replay-1', text: 'a', speaker: null, startMs: 500 },
      { utteranceId: 'x', text: 'b', speaker: 'S1', startMs: 2000 },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(parseTranscriptFile('   ')).toEqual([]);
  });
});
