import { describe, expect, it, vi } from 'vitest';
import {
  computeFaithfulness,
  computeAnswerRelevancy,
  computeContextPrecision,
  computeContextRecall,
  scoreRagas,
  meanScores,
  parseJsonVerdict,
  type Judge,
  type RagasInput,
} from '../../src/eval/ragas-metrics.js';

const input: RagasInput = {
  question: 'what ai models are used',
  answer: 'Uses Claude Haiku and Voyage.',
  contexts: ['Synthesis uses Claude Haiku 4.5.', 'Embeddings use Voyage.'],
};

/** A judge that returns a fixed string regardless of prompt. */
const fixed = (out: string): Judge => vi.fn(async () => out);

describe('parseJsonVerdict', () => {
  it('parses a bare JSON object', () => {
    expect(parseJsonVerdict('{"score":0.5}')).toEqual({ score: 0.5 });
  });
  it('parses JSON inside ```json fences with prose around it', () => {
    expect(parseJsonVerdict('Here is my verdict:\n```json\n{"score":0.9}\n```\nthanks')).toEqual({ score: 0.9 });
  });
  it('parses JSON after a prose preamble', () => {
    expect(parseJsonVerdict('Sure. {"a":1,"b":[2,3]} done')).toEqual({ a: 1, b: [2, 3] });
  });
  it('throws when no JSON is present', () => {
    expect(() => parseJsonVerdict('no json here')).toThrow();
  });
});

describe('faithfulness / context recall (claim-supported ratio)', () => {
  it('scores supported/total', async () => {
    const judge = fixed('{"claims":[{"claim":"a","supported":true},{"claim":"b","supported":false}]}');
    expect(await computeFaithfulness(input, judge)).toBe(0.5);
    expect(await computeContextRecall(input, judge)).toBe(0.5);
  });
  it('returns null when there are no claims', async () => {
    expect(await computeFaithfulness(input, fixed('{"claims":[]}'))).toBeNull();
  });
  it('all supported → 1', async () => {
    expect(await computeFaithfulness(input, fixed('{"claims":[{"supported":true},{"supported":true}]}'))).toBe(1);
  });
});

describe('answer relevancy', () => {
  it('returns the judged score', async () => {
    expect(await computeAnswerRelevancy(input, fixed('{"score":0.8}'))).toBe(0.8);
  });
  it('clamps out-of-range scores', async () => {
    expect(await computeAnswerRelevancy(input, fixed('{"score":1.5}'))).toBe(1);
    expect(await computeAnswerRelevancy(input, fixed('{"score":-0.2}'))).toBe(0);
  });
  it('null when the judge omits a numeric score', async () => {
    expect(await computeAnswerRelevancy(input, fixed('{"score":"high"}'))).toBeNull();
  });
});

describe('context precision', () => {
  it('scores relevant/total contexts', async () => {
    const judge = fixed('{"contexts":[{"index":1,"relevant":true},{"index":2,"relevant":false}]}');
    expect(await computeContextPrecision(input, judge)).toBe(0.5);
  });
});

describe('scoreRagas', () => {
  it('runs all four metrics', async () => {
    // One judge that answers each metric prompt by sniffing its keyword.
    const judge: Judge = async (prompt) => {
      if (prompt.includes('FAITHFULNESS')) return '{"claims":[{"supported":true}]}';
      if (prompt.includes('ANSWER RELEVANCY')) return '{"score":0.9}';
      if (prompt.includes('CONTEXT PRECISION')) return '{"contexts":[{"relevant":true}]}';
      if (prompt.includes('CONTEXT RECALL')) return '{"claims":[{"supported":true}]}';
      return '{}';
    };
    const s = await scoreRagas(input, judge);
    expect(s).toEqual({ faithfulness: 1, answerRelevancy: 0.9, contextPrecision: 1, contextRecall: 1 });
  });

  it('degrades a metric to null when the judge errors or returns junk (no crash)', async () => {
    const judge: Judge = async (prompt) => {
      if (prompt.includes('ANSWER RELEVANCY')) throw new Error('judge 500');
      if (prompt.includes('CONTEXT PRECISION')) return 'not json at all';
      return '{"claims":[{"supported":true}]}';
    };
    const s = await scoreRagas(input, judge);
    expect(s.answerRelevancy).toBeNull();
    expect(s.contextPrecision).toBeNull();
    expect(s.faithfulness).toBe(1);
    expect(s.contextRecall).toBe(1);
  });
});

describe('meanScores', () => {
  it('averages each metric ignoring nulls', () => {
    const m = meanScores([
      { faithfulness: 1, answerRelevancy: 0.8, contextPrecision: 1, contextRecall: null },
      { faithfulness: 0, answerRelevancy: null, contextPrecision: 0.5, contextRecall: 0.6 },
    ]);
    expect(m.faithfulness).toBe(0.5);
    expect(m.answerRelevancy).toBe(0.8);
    expect(m.contextPrecision).toBe(0.75);
    expect(m.contextRecall).toBe(0.6);
  });
  it('null when a metric is never present', () => {
    expect(meanScores([{ faithfulness: null, answerRelevancy: null, contextPrecision: null, contextRecall: null }]).faithfulness).toBeNull();
  });
});
