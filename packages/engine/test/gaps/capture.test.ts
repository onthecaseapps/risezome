import { describe, expect, it } from 'vitest';
import { shouldRecordMiss } from '../../src/gaps/capture.js';

describe('shouldRecordMiss — AE6 (filler never becomes a gap)', () => {
  it('records a no_hits miss for a substantive (non-filler) utterance', () => {
    expect(shouldRecordMiss({ reason: 'no_hits', relevance: 'clearly_substantive' })).toBe(true);
    expect(shouldRecordMiss({ reason: 'no_hits', relevance: 'ambiguous' })).toBe(true);
  });

  it('does NOT record a no_hits miss for clearly-filler (AE6)', () => {
    expect(shouldRecordMiss({ reason: 'no_hits', relevance: 'clearly_filler' })).toBe(false);
  });

  it('always records refusal / ungrounded (already past the relevance gate)', () => {
    // relevance is irrelevant on these paths — they fire from inside synthesis.
    expect(shouldRecordMiss({ reason: 'refusal', relevance: 'clearly_filler' })).toBe(true);
    expect(shouldRecordMiss({ reason: 'ungrounded', relevance: 'clearly_filler' })).toBe(true);
    expect(shouldRecordMiss({ reason: 'refusal', relevance: 'clearly_substantive' })).toBe(true);
  });
});
