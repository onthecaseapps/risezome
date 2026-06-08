import { describe, expect, it } from 'vitest';
import {
  effectiveWindow,
  isDuplicateAnswerSourceSet,
  addConsumedFinals,
  CONSUMED_FINALS_CAP,
} from '../../src/pipeline/answer-dedup';

describe('effectiveWindow (Mechanism A)', () => {
  it('returns [] for an empty window', () => {
    expect(effectiveWindow([], [])).toEqual([]);
    expect(effectiveWindow([], ['anything'])).toEqual([]);
  });

  it('always keeps the current (last) utterance even if it is consumed', () => {
    expect(effectiveWindow(['q1'], ['q1'])).toEqual(['q1']);
    // 'q' is both the last element AND consumed → still kept; 'a' is not consumed.
    expect(effectiveWindow(['a', 'q'], ['q'])).toEqual(['a', 'q']);
    // 'a' consumed + non-current → dropped; 'q' last → kept even though consumed.
    expect(effectiveWindow(['a', 'q'], ['a', 'q'])).toEqual(['q']);
  });

  it('drops consumed non-current utterances, keeps the rest in order', () => {
    expect(effectiveWindow(['a', 'b', 'c', 'd'], ['b'])).toEqual(['a', 'c', 'd']);
    expect(effectiveWindow(['a', 'b', 'c'], ['a', 'b'])).toEqual(['c']);
  });

  it('returns the full window when nothing is consumed', () => {
    expect(effectiveWindow(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });
});

describe('isDuplicateAnswerSourceSet (Mechanism B predicate, pure)', () => {
  const now = 1_000_000;
  const windowMs = 300_000;

  it('is false for an empty candidate set', () => {
    expect(
      isDuplicateAnswerSourceSet([], [{ docIds: ['x'], at: now }], now, windowMs),
    ).toBe(false);
  });

  it('is true for an exact match', () => {
    expect(
      isDuplicateAnswerSourceSet(['a', 'b'], [{ docIds: ['a', 'b'], at: now }], now, windowMs),
    ).toBe(true);
  });

  it('is true regardless of order (set containment)', () => {
    expect(
      isDuplicateAnswerSourceSet(['b', 'a'], [{ docIds: ['a', 'b'], at: now }], now, windowMs),
    ).toBe(true);
  });

  it('is true for a subset of an answered set (adds no new source)', () => {
    expect(
      isDuplicateAnswerSourceSet(['a'], [{ docIds: ['a', 'b', 'c'], at: now }], now, windowMs),
    ).toBe(true);
  });

  it('is false for a superset (candidate adds a new source)', () => {
    expect(
      isDuplicateAnswerSourceSet(['a', 'b', 'c'], [{ docIds: ['a', 'b'], at: now }], now, windowMs),
    ).toBe(false);
  });

  it('is false when the candidate introduces a new id', () => {
    expect(
      isDuplicateAnswerSourceSet(['a', 'z'], [{ docIds: ['a', 'b'], at: now }], now, windowMs),
    ).toBe(false);
  });

  it('is false when the only matching entry is expired by the window', () => {
    expect(
      isDuplicateAnswerSourceSet(
        ['a', 'b'],
        [{ docIds: ['a', 'b'], at: now - windowMs }],
        now,
        windowMs,
      ),
    ).toBe(false);
    // still within the window ⇒ matches
    expect(
      isDuplicateAnswerSourceSet(
        ['a', 'b'],
        [{ docIds: ['a', 'b'], at: now - (windowMs - 1) }],
        now,
        windowMs,
      ),
    ).toBe(true);
  });

  it('matches across multiple answered entries (any-of)', () => {
    expect(
      isDuplicateAnswerSourceSet(
        ['c'],
        [
          { docIds: ['a', 'b'], at: now },
          { docIds: ['c', 'd'], at: now },
        ],
        now,
        windowMs,
      ),
    ).toBe(true);
  });

  // B3: near-duplicate re-asks retrieve a mostly-overlapping (not identical) card
  // set. The strict-subset test missed these; the 0.7 overlap ratio catches them.
  it('is true at majority overlap even when the candidate adds one fresh source (4/5)', () => {
    expect(
      isDuplicateAnswerSourceSet(
        ['a', 'b', 'c', 'd', 'z'],
        [{ docIds: ['a', 'b', 'c', 'd', 'e'], at: now }],
        now,
        windowMs,
      ),
    ).toBe(true); // 4/5 = 0.8 >= 0.7
  });

  it('is false when overlap is below the ratio (2/5 — a genuinely new question)', () => {
    expect(
      isDuplicateAnswerSourceSet(
        ['a', 'b', 'x', 'y', 'z'],
        [{ docIds: ['a', 'b', 'c', 'd', 'e'], at: now }],
        now,
        windowMs,
      ),
    ).toBe(false); // 2/5 = 0.4 < 0.7
  });

  it('honors a custom overlap ratio argument', () => {
    const args = ['a', 'b', 'x'] as const;
    const sets = [{ docIds: ['a', 'b', 'c'], at: now }];
    // 2/3 = 0.667: below the default 0.7, but above an explicit 0.6.
    expect(isDuplicateAnswerSourceSet([...args], sets, now, windowMs)).toBe(false);
    expect(isDuplicateAnswerSourceSet([...args], sets, now, windowMs, 0.6)).toBe(true);
  });
});

describe('addConsumedFinals (Mechanism A record side, pure)', () => {
  it('appends the window to consumed', () => {
    expect(addConsumedFinals(['a'], ['b', 'c'], 60)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes (order preserved, last-wins for cap freshness)', () => {
    expect(addConsumedFinals(['a', 'b'], ['b', 'c'], 60)).toEqual(['a', 'b', 'c']);
  });

  it('drops empty strings', () => {
    expect(addConsumedFinals(['a'], ['', 'b', ''], 60)).toEqual(['a', 'b']);
  });

  it('caps to the most-recent `cap` entries', () => {
    const consumed = ['a', 'b', 'c'];
    const window = ['d', 'e'];
    expect(addConsumedFinals(consumed, window, 3)).toEqual(['c', 'd', 'e']);
  });

  it('does not mutate its inputs', () => {
    const consumed = ['a'];
    const window = ['b'];
    addConsumedFinals(consumed, window, 60);
    expect(consumed).toEqual(['a']);
    expect(window).toEqual(['b']);
  });

  it('exports the canonical cap constant', () => {
    expect(CONSUMED_FINALS_CAP).toBe(60);
  });
});
