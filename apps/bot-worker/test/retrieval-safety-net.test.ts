import { describe, expect, it } from 'vitest';
import type { SkillResult } from '@risezome/engine/skills';
import type { SynthesisSource } from '@risezome/engine/synthesize';
import { decideToolSource, buildMergedSources } from '../src/retrieval-safety-net.js';
// Import the REAL not-connected results so this test breaks if their shape
// (esp. the notConnected flag the demotion keys on) ever drifts.
import { NO_GITHUB_SOURCE_RESULT } from '../src/skills/github/live-helpers.js';
import { NO_TRELLO_SOURCE_RESULT } from '../src/skills/trello/filter.js';

/**
 * Router safety-net (plan U4). Characterizes the keep-vs-drop decision and the
 * `mergedSources` assembly that feed synthesis, in isolation from the full
 * `maybeRetrieveAndEmit` pipeline (which has no test of its own).
 */

const CARDS: SynthesisSource[] = [
  { rank: 1, title: 'doc A', text: 'card one' },
  { rank: 2, title: 'doc B', text: 'card two' },
];

function clean(): SkillResult {
  return { kind: 'count', summary: '5 open issues.' };
}
function repaired(): SkillResult {
  return {
    kind: 'count',
    summary: '12 open issues.',
    recovery: { status: 'repaired', neutralized: [{ arg: 'labels', value: 'case' }], note: "No 'case' label." },
  };
}
function unresolved(): SkillResult {
  return {
    kind: 'count',
    summary: 'Whole-repo count.',
    recovery: { status: 'unresolved', note: 'Dropped the only filter.' },
  };
}

describe('decideToolSource', () => {
  it('keeps a clean result (no recovery signal)', () => {
    expect(decideToolSource(clean())).toEqual({ keep: true, status: 'clean' });
  });

  it('keeps a repaired result (a real scope survived) — R6/KD4', () => {
    expect(decideToolSource(repaired())).toEqual({ keep: true, status: 'repaired' });
  });

  it('drops an unresolved result (KTD8) so synthesis falls back to RAG — R5/AE4', () => {
    expect(decideToolSource(unresolved())).toEqual({ keep: false, status: 'unresolved' });
  });

  it('drops a not-connected CTA when RAG sources exist (real GitHub/Trello results)', () => {
    expect(decideToolSource(NO_GITHUB_SOURCE_RESULT, { ragCount: 2 })).toEqual({
      keep: false,
      status: 'unresolved',
    });
    expect(decideToolSource(NO_TRELLO_SOURCE_RESULT, { ragCount: 2 })).toEqual({
      keep: false,
      status: 'unresolved',
    });
  });

  it('KEEPS a not-connected CTA when there is no RAG to fall back to', () => {
    expect(decideToolSource(NO_GITHUB_SOURCE_RESULT, { ragCount: 0 })).toEqual({
      keep: true,
      status: 'clean',
    });
    // …and with no ragCount opt at all (the CTA is the best response).
    expect(decideToolSource(NO_TRELLO_SOURCE_RESULT)).toEqual({ keep: true, status: 'clean' });
  });

  it('does NOT demote a real zero-result answer ("0 open issues") even with RAG present', () => {
    const zero: SkillResult = { kind: 'count', summary: 'There are 0 open issues.' };
    expect(decideToolSource(zero, { ragCount: 2 })).toEqual({ keep: true, status: 'clean' });
  });
});

describe('buildMergedSources', () => {
  it('no skill result → RAG-only', () => {
    const { mergedSources, status } = buildMergedSources(null, 'github_count', {}, CARDS);
    expect(mergedSources).toEqual(CARDS);
    expect(status).toBe('none');
  });

  it('clean result → tool source at [0], cards follow', () => {
    const { mergedSources, status } = buildMergedSources(clean(), 'github_count', { state: 'open' }, CARDS);
    expect(mergedSources).toHaveLength(3);
    expect(mergedSources[0]?.rank).toBe(0); // tool source
    expect(mergedSources[0]?.suspect).toBeUndefined();
    expect(mergedSources.slice(1)).toEqual(CARDS);
    expect(status).toBe('clean');
  });

  it('repaired result → kept at [0] with the suspect flag + caveat, cards follow (R6/KD4)', () => {
    const { mergedSources, status } = buildMergedSources(repaired(), 'github_count', { labels: ['case'] }, CARDS);
    expect(mergedSources).toHaveLength(3);
    expect(mergedSources[0]?.suspect).toBe(true);
    expect(mergedSources[0]?.text).toContain("No 'case' label.");
    expect(mergedSources.slice(1)).toEqual(CARDS);
    expect(status).toBe('repaired');
  });

  it('unresolved result → dropped, RAG-only (AE4/R5)', () => {
    const { mergedSources, status } = buildMergedSources(unresolved(), 'github_count', { labels: ['case'] }, CARDS);
    expect(mergedSources).toEqual(CARDS);
    expect(status).toBe('unresolved');
  });

  it('flash-fix invariant: an unresolved tool with NO cards yields zero sources, so synthesis never fires', () => {
    // The synthesis gate is `sources.length > 0`. A dropped tool + no cards
    // means nothing reaches synthesis — no synthesisStart can be emitted for
    // an answer that was going to be dropped (KTD7).
    const { mergedSources } = buildMergedSources(unresolved(), 'github_count', {}, []);
    expect(mergedSources).toHaveLength(0);
  });
});
