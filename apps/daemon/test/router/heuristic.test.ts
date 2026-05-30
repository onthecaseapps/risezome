import { describe, expect, it } from 'vitest';
import { HEURISTIC_PATTERNS, isToolShaped } from '../../src/router/heuristic.js';

describe('isToolShaped — positive matches', () => {
  it.each([
    'how many open issues are there',
    'how many bugs are there',
    'count of open PRs',
    'count all open issues',
    'list all PRs by jamie',
    'show all bugs assigned to nathan',
    'find all open issues',
    "what's open right now",
    'what is open in the repo',
    'what are open',
    'what are closed',
    'any open bugs',
    'are there any phase 2 issues',
    'is there a label for ux',
    'who has open bugs',
    'who owns the auth refactor',
    'all the PRs assigned to jamie',
    'issues authored by alice',
    'recently updated docs',
    'updated this week',
    'updated since monday',
    'updated in the last 3 days',
    'changed this week',
    "what's new since last meeting",
  ])('matches: %s', (utterance) => {
    expect(isToolShaped(utterance)).toBe(true);
  });
});

describe('isToolShaped — negative matches', () => {
  it.each([
    'how does the sidecar handshake work',
    'what does U13 mean',
    'tell me about the synthesizer architecture',
    'what is plan unit U13 about',
    'explain the retrieval pipeline',
    "let's talk about prompt caching",
    'I think we should switch to webrtc vad',
    'walk me through the meeting lifecycle',
  ])('does not match: %s', (utterance) => {
    expect(isToolShaped(utterance)).toBe(false);
  });
});

describe('isToolShaped — edge cases', () => {
  it('returns false for empty string', () => {
    expect(isToolShaped('')).toBe(false);
  });

  it('returns false for whitespace-only input', () => {
    expect(isToolShaped('   \n  \t')).toBe(false);
  });

  it('matches regardless of case', () => {
    expect(isToolShaped('How MANY Open Issues')).toBe(true);
  });

  it('tolerates surrounding punctuation', () => {
    expect(isToolShaped('  how many open issues?!  ')).toBe(true);
  });

  it('exports a non-empty pattern list for inspection', () => {
    expect(HEURISTIC_PATTERNS.length).toBeGreaterThan(5);
  });

  it('handles non-string defensively (TypeScript guards this, but runtime should not throw)', () => {
    expect(isToolShaped(undefined as unknown as string)).toBe(false);
  });
});
