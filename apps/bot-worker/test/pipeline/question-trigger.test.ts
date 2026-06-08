import { describe, expect, it } from 'vitest';
import {
  classifyLane,
  isNearDuplicateQuestion,
  buildQuestionQuery,
} from '../../src/pipeline/question-trigger.js';

describe('classifyLane', () => {
  it('routes a substantive question to the question lane', () => {
    expect(classifyLane('how many open github issues are there')).toBe('question');
  });

  it('routes filler/ambient talk to the ambient lane', () => {
    expect(classifyLane('yeah totally')).toBe('ambient');
  });
});

describe('isNearDuplicateQuestion', () => {
  const now = 1_000_000;
  it('is true when a recent answered question is within the distance threshold', () => {
    const vec = [1, 0, 0];
    expect(isNearDuplicateQuestion(vec, [{ embedding: [1, 0, 0], at: now - 1000 }], now)).toBe(true);
  });

  it('is false for an orthogonal (far) question', () => {
    const vec = [1, 0, 0];
    expect(isNearDuplicateQuestion(vec, [{ embedding: [0, 1, 0], at: now - 1000 }], now)).toBe(false);
  });

  it('is false when the only near match is outside the recency window', () => {
    const vec = [1, 0, 0];
    expect(isNearDuplicateQuestion(vec, [{ embedding: [1, 0, 0], at: now - 10_000_000 }], now)).toBe(false);
  });

  it('is false against an empty history', () => {
    expect(isNearDuplicateQuestion([1, 0, 0], [], now)).toBe(false);
  });
});

describe('buildQuestionQuery', () => {
  it('returns a standalone question undiluted', () => {
    expect(buildQuestionQuery('how many open github issues are there', ['prior talk', 'how many open github issues are there'], undefined)).toBe(
      'how many open github issues are there',
    );
  });

  it('anchors a short follow-up to the prior final', () => {
    const out = buildQuestionQuery('how many', ['are there any open github issues', 'how many'], undefined);
    expect(out).toBe('are there any open github issues how many');
  });

  it('anchors a connective-led follow-up to the prior final', () => {
    const out = buildQuestionQuery('and how many are open', ['are there github issues', 'and how many are open'], undefined);
    expect(out).toContain('are there github issues');
    expect(out).toContain('and how many are open');
  });
});
