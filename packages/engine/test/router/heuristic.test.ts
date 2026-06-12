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
    'is there an open issue for ux',
    'are there any open bugs left',
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
    // Regression: "is/are there a ..." existence/plan questions are RAG, not
    // tool-shaped. These mis-routed to github_recently_updated before the gate
    // required a github-entity noun.
    "is there a plan to handle gaps in a customer's knowledge base",
    'is there a way to surface knowledge gaps',
    'is there a label for ux',
    'are there any plans to add SSO',
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


  it('matches passive assignee phrasing without a literal "to" (STT-mangled org names)', () => {
    // Deepgram transcribed "assigned to onthecaseapps" as "assigned on the case
    // apps", which broke the `assigned to` shape and the skill never routed.
    expect(isToolShaped('what github issues are assigned on the case apps')).toBe(true);
    expect(isToolShaped('which tickets were assigned last week')).toBe(true);
    expect(isToolShaped("who's assigned on the retrieval work")).toBe(true);
    expect(isToolShaped('who is assigned here')).toBe(true);
  });

  it('plain past-tense chatter still requires the assigned verb (no over-trigger)', () => {
    expect(isToolShaped('we discussed the plan yesterday')).toBe(false);
    expect(isToolShaped('how does the assignment algorithm work')).toBe(false);
  });


  it('keyword co-occurrence: entity noun + operation word in ANY order', () => {
    expect(isToolShaped('give me the open issues')).toBe(true);
    expect(isToolShaped('issues created by nathan')).toBe(true);
    expect(isToolShaped('to whom are these issues assigned')).toBe(true);
    expect(isToolShaped('whose tickets are stale')).toBe(true);
    expect(isToolShaped('newest prs in the repo')).toBe(true);
  });

  it('co-occurrence requires BOTH halves — topic talk alone stays RAG', () => {
    expect(isToolShaped('how does the issue page render')).toBe(false); // noun, no op
    expect(isToolShaped('we shipped the cards feature yesterday')).toBe(false); // noun, no op
    expect(isToolShaped('who broke the build')).toBe(false); // op, no noun
    expect(isToolShaped('the open bar at the retention party')).toBe(false); // op, no noun
  });

  it('exports a non-empty pattern list for inspection', () => {
    expect(HEURISTIC_PATTERNS.length).toBeGreaterThan(5);
  });

  it('handles non-string defensively (TypeScript guards this, but runtime should not throw)', () => {
    expect(isToolShaped(undefined as unknown as string)).toBe(false);
  });
});
