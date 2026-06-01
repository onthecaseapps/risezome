import { describe, expect, it } from 'vitest';
import { classifyQueryComplexity, shouldExpandOnMiss } from '../../src/query-route/query-route.js';

describe('classifyQueryComplexity', () => {
  it('flags thematic/aggregate questions as scattered', () => {
    expect(classifyQueryComplexity('what ai models are used in the project')).toBe('scattered');
    expect(classifyQueryComplexity('list all the connectors')).toBe('scattered');
    expect(classifyQueryComplexity('how many open issues are there')).toBe('scattered');
    expect(classifyQueryComplexity('which database do we use')).toBe('scattered');
  });

  it('flags long queries as scattered even without a keyword', () => {
    expect(classifyQueryComplexity('the deposit refund and the cancellation fee timing question here')).toBe('scattered');
  });

  it('treats short specific lookups as simple', () => {
    expect(classifyQueryComplexity('deepgram reconnect')).toBe('simple');
    expect(classifyQueryComplexity('voyage api key')).toBe('simple');
  });
});

describe('shouldExpandOnMiss', () => {
  it('expands a substantive scattered question on a miss', () => {
    expect(shouldExpandOnMiss('what ai models are used in the project')).toBe(true);
  });

  it('expands a medium-length (5+ word) question on a miss', () => {
    expect(shouldExpandOnMiss('how does the upload resume work')).toBe(true);
  });

  it('does NOT expand ultra-short fragments / filler', () => {
    expect(shouldExpandOnMiss('what models')).toBe(false);
    expect(shouldExpandOnMiss('uh yeah')).toBe(false);
    expect(shouldExpandOnMiss('voyage')).toBe(false);
  });
});
