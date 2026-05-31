import { describe, expect, it } from 'vitest';
import { adaptRecallMessage } from '../src/recall-adapter';

/**
 * Fixture-based characterization tests for the Recall.ai message
 * adapter (R27). These tests are the regression net for the bridge
 * between Recall's transport contract and the engine's Utterance
 * contract — when either contract drifts, these tests are what
 * should catch it.
 */

function transcriptDataMessage(opts: {
  isPartial?: boolean;
  words: Array<{ text: string; startRel: number; endRel: number }>;
  participant?: { id?: number | string; name?: string };
}): unknown {
  return {
    event: opts.isPartial ? 'transcript.partial_data' : 'transcript.data',
    data: {
      data: {
        words: opts.words.map((w) => ({
          text: w.text,
          start_timestamp: { relative: w.startRel },
          end_timestamp: { relative: w.endRel },
        })),
        participant: opts.participant,
      },
    },
  };
}

describe('adaptRecallMessage — happy path', () => {
  it('maps a final transcript.data with 3 words from a named speaker', () => {
    const msg = transcriptDataMessage({
      words: [
        { text: 'Hello', startRel: 1.0, endRel: 1.3 },
        { text: 'team,', startRel: 1.4, endRel: 1.6 },
        { text: 'standup.', startRel: 1.7, endRel: 2.1 },
      ],
      participant: { id: 42, name: 'Nathan' },
    });

    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error(`expected utterance, got ${out.kind}`);

    expect(out.utterance.text).toBe('Hello team, standup.');
    expect(out.utterance.isFinal).toBe(true);
    expect(out.utterance.speaker).toBe('Nathan');
    expect(out.utterance.startMs).toBe(1000);
    expect(out.utterance.endMs).toBe(2100);
    expect(out.utterance.revision).toBe(0);
    expect(out.utterance.utteranceId).toBe('42::1000');
  });

  it('maps a partial_data message with isFinal=false', () => {
    const msg = transcriptDataMessage({
      isPartial: true,
      words: [
        { text: 'I', startRel: 5.0, endRel: 5.1 },
        { text: 'think', startRel: 5.2, endRel: 5.4 },
      ],
      participant: { id: 7, name: 'Priya' },
    });

    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error('expected utterance');
    expect(out.utterance.isFinal).toBe(false);
    expect(out.utterance.speaker).toBe('Priya');
  });

  it('keeps utteranceId stable across partial and final for the same speech', () => {
    // A partial then a final with the same first-word start time and
    // participant — represents Recall sending a partial then completing
    // the same utterance.
    const partial = transcriptDataMessage({
      isPartial: true,
      words: [{ text: 'Hello', startRel: 1.0, endRel: 1.3 }],
      participant: { id: 42, name: 'Nathan' },
    });
    const final = transcriptDataMessage({
      words: [
        { text: 'Hello', startRel: 1.0, endRel: 1.3 },
        { text: 'world.', startRel: 1.4, endRel: 1.7 },
      ],
      participant: { id: 42, name: 'Nathan' },
    });

    const a = adaptRecallMessage(partial);
    const b = adaptRecallMessage(final);
    if (a.kind !== 'utterance' || b.kind !== 'utterance') throw new Error('expected utterances');

    expect(a.utterance.utteranceId).toBe(b.utterance.utteranceId);
    expect(a.utterance.isFinal).toBe(false);
    expect(b.utterance.isFinal).toBe(true);
  });
});

describe('adaptRecallMessage — edge cases', () => {
  it('handles missing participant name (omits speaker entirely)', () => {
    const msg = transcriptDataMessage({
      words: [{ text: 'Hi', startRel: 0, endRel: 0.2 }],
      participant: { id: 99 },
    });
    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error('expected utterance');
    expect(out.utterance.speaker).toBeUndefined();
  });

  it('handles missing participant entirely (uses "unknown" in id)', () => {
    const msg = transcriptDataMessage({
      words: [{ text: 'Hi', startRel: 0, endRel: 0.2 }],
    });
    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error('expected utterance');
    expect(out.utterance.utteranceId).toBe('unknown::0');
  });

  it('handles string participant ids (some Recall accounts use UUIDs)', () => {
    const msg = transcriptDataMessage({
      words: [{ text: 'Hi', startRel: 0, endRel: 0.2 }],
      participant: { id: 'p_abc123', name: 'Marco' },
    });
    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error('expected utterance');
    expect(out.utterance.utteranceId).toBe('p_abc123::0');
  });

  it('returns ignored:unknown-event for participant_events.join', () => {
    const msg = { event: 'participant_events.join', data: {} };
    const out = adaptRecallMessage(msg);
    expect(out.kind).toBe('ignored');
    if (out.kind === 'ignored') expect(out.reason).toBe('unknown-event');
  });

  it('returns ignored:empty-words when words array is empty', () => {
    const msg = transcriptDataMessage({
      words: [],
      participant: { id: 1, name: 'X' },
    });
    const out = adaptRecallMessage(msg);
    expect(out.kind).toBe('ignored');
    if (out.kind === 'ignored') expect(out.reason).toBe('empty-words');
  });

  it('returns ignored:malformed for non-object input', () => {
    expect(adaptRecallMessage(null).kind).toBe('ignored');
    expect(adaptRecallMessage('string').kind).toBe('ignored');
    expect(adaptRecallMessage(42).kind).toBe('ignored');
  });

  it('skips word tokens with empty text', () => {
    const msg = transcriptDataMessage({
      words: [
        { text: '', startRel: 1.0, endRel: 1.0 },
        { text: 'real', startRel: 1.1, endRel: 1.3 },
      ],
      participant: { id: 1, name: 'A' },
    });
    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error('expected utterance');
    expect(out.utterance.text).toBe('real');
  });

  it('returns ignored:empty-words when all word texts are empty strings', () => {
    const msg = transcriptDataMessage({
      words: [{ text: '', startRel: 0, endRel: 0 }],
      participant: { id: 1 },
    });
    const out = adaptRecallMessage(msg);
    expect(out.kind).toBe('ignored');
    if (out.kind === 'ignored') expect(out.reason).toBe('empty-words');
  });

  it('handles missing end_timestamp by setting endMs = startMs', () => {
    // Defensive — if Recall ever drops end_timestamp on a partial.
    const msg = {
      event: 'transcript.partial_data',
      data: {
        data: {
          words: [{ text: 'um', start_timestamp: { relative: 2.5 } }],
          participant: { id: 1, name: 'X' },
        },
      },
    };
    const out = adaptRecallMessage(msg);
    if (out.kind !== 'utterance') throw new Error('expected utterance');
    expect(out.utterance.startMs).toBe(2500);
    expect(out.utterance.endMs).toBe(2500);
  });
});
