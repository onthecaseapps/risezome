import { describe, expect, it } from 'vitest';
import {
  cosineDistance,
  dedupeWithinBatch,
  findMergeTarget,
  GAP_MERGE_MAX_DISTANCE,
} from '../../src/gaps/merge.js';

/** Unit vector at angle theta (radians) in the first two dims. */
function vecAt(theta: number): number[] {
  return [Math.cos(theta), Math.sin(theta), 0, 0];
}

describe('cosineDistance', () => {
  it('is 0 for identical direction and 1 for orthogonal', () => {
    expect(cosineDistance([1, 0, 0], [2, 0, 0])).toBeCloseTo(0, 6);
    expect(cosineDistance([1, 0, 0], [0, 1, 0])).toBeCloseTo(1, 6);
  });
  it('returns 1 for a zero vector (no NaN)', () => {
    expect(cosineDistance([0, 0, 0], [1, 0, 0])).toBe(1);
  });
});

describe('dedupeWithinBatch — AE1 / AE2', () => {
  it('AE1: two near-equivalent phrasings in one batch collapse to one group', () => {
    const groups = dedupeWithinBatch([
      { item: 'is the oauth2 cutover done?', vector: vecAt(0) },
      { item: 'where are we on auth migration?', vector: vecAt(0.1) }, // ~0.005 distance
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(2);
  });

  it('AE2: keyword-overlap-but-different questions stay separate', () => {
    const groups = dedupeWithinBatch([
      { item: 'what is our refund window?', vector: vecAt(0) },
      { item: 'how do i build a refund UI widget?', vector: vecAt(Math.PI / 2) }, // orthogonal
    ]);
    expect(groups).toHaveLength(2);
  });

  it('borderline: just inside the threshold merges, just outside does not', () => {
    // distance = 1 - cos(theta). default threshold 0.22 → cos 0.78 → theta≈0.6797
    const inside = Math.acos(0.8); // distance 0.20 < 0.22
    const outside = Math.acos(0.75); // distance 0.25 > 0.22
    expect(dedupeWithinBatch([{ item: 'a', vector: vecAt(0) }, { item: 'b', vector: vecAt(inside) }])).toHaveLength(1);
    expect(dedupeWithinBatch([{ item: 'a', vector: vecAt(0) }, { item: 'b', vector: vecAt(outside) }])).toHaveLength(2);
  });

  it('empty batch → no groups; single item → one group of one', () => {
    expect(dedupeWithinBatch([])).toHaveLength(0);
    const one = dedupeWithinBatch([{ item: 'x', vector: vecAt(0) }]);
    expect(one).toHaveLength(1);
    expect(one[0]!.members).toEqual(['x']);
  });
});

describe('findMergeTarget', () => {
  it('returns the nearest candidate within threshold', () => {
    const target = findMergeTarget(vecAt(0), [
      { gapId: 'far', vector: vecAt(Math.PI / 2) },
      { gapId: 'near', vector: vecAt(0.1) },
    ]);
    expect(target).toBe('near');
  });

  it('returns null when no candidate is within threshold (→ create new gap)', () => {
    const target = findMergeTarget(vecAt(0), [{ gapId: 'far', vector: vecAt(Math.PI / 2) }]);
    expect(target).toBeNull();
  });

  it('uses the configured default threshold', () => {
    expect(GAP_MERGE_MAX_DISTANCE).toBeGreaterThan(0);
    expect(GAP_MERGE_MAX_DISTANCE).toBeLessThan(0.45);
  });
});
