import { describe, expect, it } from 'vitest';
import {
  jaccard,
  shouldReplaceSynthesis,
  REPLACE_WINDOW_MS,
  type PriorSynthesis,
} from '../../src/debug/synthesis-replace';

const prior = (docIds: string[], completedAt = 1000): PriorSynthesis => ({
  synthesisId: 'syn_prev',
  sourceDocIds: docIds,
  completedAt,
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });
  it('is 0 when either side is empty', () => {
    expect(jaccard([], ['a'])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });
  it('computes partial overlap as intersection over union', () => {
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(2 / 4);
  });
});

describe('shouldReplaceSynthesis', () => {
  const now = 10_000;

  it('replaces when the same docs reappear inside the window (the re-ask case)', () => {
    // This is the regression: re-asking the same question retrieves the same
    // DOCS (with brand-new card ids). Doc-id overlap must drive replacement.
    expect(
      shouldReplaceSynthesis({
        currentDocIds: ['doc1', 'doc2'],
        prior: prior(['doc1', 'doc2'], now - 1000),
        now,
      }),
    ).toBe(true);
  });

  it('does not replace when the prior synthesis covered different docs', () => {
    expect(
      shouldReplaceSynthesis({
        currentDocIds: ['doc1', 'doc2'],
        prior: prior(['doc8', 'doc9'], now - 1000),
        now,
      }),
    ).toBe(false);
  });

  it('does not replace once the prior is older than the window', () => {
    expect(
      shouldReplaceSynthesis({
        currentDocIds: ['doc1', 'doc2'],
        prior: prior(['doc1', 'doc2'], now - REPLACE_WINDOW_MS - 1),
        now,
      }),
    ).toBe(false);
  });

  it('does not replace when there is no prior synthesis', () => {
    expect(shouldReplaceSynthesis({ currentDocIds: ['doc1'], prior: null, now })).toBe(false);
  });

  it('replaces at exactly the 0.5 overlap threshold (3-of-4 union)', () => {
    // {a,b,c} vs {b,c,d} = 2/4 = 0.5 → meets the >= threshold.
    expect(
      shouldReplaceSynthesis({
        currentDocIds: ['a', 'b', 'c'],
        prior: prior(['b', 'c', 'd'], now - 1000),
        now,
      }),
    ).toBe(true);
  });
});
