import { describe, expect, it } from 'vitest';
import { bearerMatches } from '../src/shared-secret';

/** U12 / S13: the meeting-end control endpoint authenticates via a shared bearer. */

const SECRET = 'bot-worker-secret-' + 'z'.repeat(40);

describe('bearerMatches (U12)', () => {
  it('accepts the correct bearer secret', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(bearerMatches(`Bearer ${SECRET}wrong`, SECRET)).toBe(false);
    expect(bearerMatches(`Bearer totally-different`, SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(bearerMatches(undefined, SECRET)).toBe(false);
    expect(bearerMatches('', SECRET)).toBe(false);
    expect(bearerMatches(SECRET, SECRET)).toBe(false); // no "Bearer " prefix
    expect(bearerMatches(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  it('rejects everything when the configured secret is empty', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer anything', '')).toBe(false);
  });
});
