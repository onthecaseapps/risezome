import { describe, expect, it } from 'vitest';
import {
  computeRecall,
  evaluateAnswer,
  scoreQuestion,
  summarize,
  type GoldenQuestion,
  type RetrievedDoc,
} from '../../eval/lib/corpus-replay.js';

function doc(over: Partial<RetrievedDoc> = {}): RetrievedDoc {
  return { chunkId: 'c1', docId: 'github:o/r:README.md@abc', title: 'README.md', score: 0.5, ...over };
}

describe('computeRecall', () => {
  it('matches must-surface labels against docId OR title (case-insensitive)', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ docId: 'x:corpus-search.ts', title: 'corpus-search.ts' })];
    const out = computeRecall(retrieved, ['readme', 'CORPUS-SEARCH']);
    expect(out.recall).toBe(1);
    expect(out.surfaced).toEqual(['readme', 'CORPUS-SEARCH']);
    expect(out.missed).toEqual([]);
  });

  it('reports partial recall and the missed labels', () => {
    const out = computeRecall([doc({ title: 'README.md' })], ['readme', 'voyage', 'deepgram']);
    expect(out.recall).toBeCloseTo(1 / 3);
    expect(out.surfaced).toEqual(['readme']);
    expect(out.missed).toEqual(['voyage', 'deepgram']);
  });

  it('returns null recall when nothing is labeled', () => {
    expect(computeRecall([doc()], []).recall).toBeNull();
    expect(computeRecall([doc()], undefined).recall).toBeNull();
  });
});

describe('evaluateAnswer', () => {
  it('is true only when every expected substring is present (case-insensitive)', () => {
    expect(evaluateAnswer('Uses Claude Haiku and Voyage', ['haiku', 'voyage'])).toBe(true);
    expect(evaluateAnswer('Uses Claude Haiku only', ['haiku', 'voyage'])).toBe(false);
  });
  it('is null when nothing is expected', () => {
    expect(evaluateAnswer('anything', undefined)).toBeNull();
  });
});

describe('scoreQuestion', () => {
  const q: GoldenQuestion = {
    q: 'what ai models are used',
    must_surface: ['readme', 'voyage'],
    expect_answer_contains: ['Haiku', 'Voyage'],
  };

  it('passes when no refusal and the answer contains all expected substrings', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ title: 'voyage.ts' })];
    const r = scoreQuestion(q, retrieved, 'We use Claude Haiku and Voyage embeddings.', false);
    expect(r.pass).toBe(true);
    expect(r.recall).toBe(1);
    expect(r.answerContainsAll).toBe(true);
  });

  it('does NOT fail on a missing must-surface doc when the answer is correct (recall is informational, non-gating)', () => {
    const retrieved = [doc({ title: 'README.md' })]; // voyage doc missing from retrieval
    const r = scoreQuestion(q, retrieved, 'We use Claude Haiku and Voyage.', false);
    expect(r.pass).toBe(true); // answer is correct — the brittle keyword miss must not fail it
    expect(r.recall).toBeCloseTo(0.5); // still reported as a retrieval signal
    expect(r.missed).toEqual(['voyage']);
  });

  it('fails when the system refuses an answerable question', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ title: 'voyage.ts' })];
    const r = scoreQuestion(q, retrieved, '', true);
    expect(r.pass).toBe(false);
    expect(r.isRefusal).toBe(true);
  });

  it('fails when the answer omits an expected substring even with full recall', () => {
    const retrieved = [doc({ title: 'README.md' }), doc({ title: 'voyage.ts' })];
    const r = scoreQuestion(q, retrieved, 'We use Claude Haiku.', false); // no Voyage
    expect(r.pass).toBe(false);
    expect(r.answerContainsAll).toBe(false);
  });

  it('expect_refusal question passes iff the system refuses', () => {
    const refusalQ: GoldenQuestion = { q: 'lunch?', expect_refusal: true };
    expect(scoreQuestion(refusalQ, [], '', true).pass).toBe(true);
    expect(scoreQuestion(refusalQ, [doc()], 'some answer', false).pass).toBe(false);
  });

  it('unlabeled non-refusal question passes on any grounded answer', () => {
    const bareQ: GoldenQuestion = { q: 'how does X work' };
    expect(scoreQuestion(bareQ, [doc()], 'X works like so.', false).pass).toBe(true);
    expect(scoreQuestion(bareQ, [doc()], '', true).pass).toBe(false);
  });
});

describe('summarize', () => {
  it('aggregates pass-rate and mean recall over labeled questions', () => {
    const qLabeled: GoldenQuestion = { q: 'a', must_surface: ['x'] };
    const qUnlabeled: GoldenQuestion = { q: 'b' };
    const results = [
      scoreQuestion(qLabeled, [doc({ title: 'x' })], 'ans', false), // pass (no refusal), recall 1
      scoreQuestion(qLabeled, [doc({ title: 'y' })], '', true), // fail (refusal), recall 0
      scoreQuestion(qUnlabeled, [doc()], 'ans', false), // pass, recall null
    ];
    const s = summarize(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.meanRecall).toBeCloseTo(0.5); // (1 + 0) / 2 over labeled, null excluded
  });

  it('handles an empty result set', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.meanRecall).toBeNull();
  });
});
