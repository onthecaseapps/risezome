import { describe, expect, it } from 'vitest';
import { augmentQuery } from '../../src/query-expand/query-expand.js';

describe('augmentQuery', () => {
  it('appends de-duplicated terms not already in the query', () => {
    expect(augmentQuery('what ai models are used', ['Claude', 'Voyage', 'Deepgram'])).toBe(
      'what ai models are used Claude Voyage Deepgram',
    );
  });

  it('skips terms already present in the query (case-insensitive)', () => {
    expect(augmentQuery('which models do we use', ['Models', 'Gemini'])).toBe(
      'which models do we use Gemini',
    );
  });

  it('de-dupes repeated terms and drops blanks', () => {
    expect(augmentQuery('q', ['A', 'a', '  ', 'B'])).toBe('q A B');
  });

  it('returns the original query unchanged when no new terms', () => {
    expect(augmentQuery('voyage', ['voyage'])).toBe('voyage');
    expect(augmentQuery('voyage', [])).toBe('voyage');
  });
});
