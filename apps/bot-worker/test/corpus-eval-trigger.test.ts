import { describe, expect, it } from 'vitest';
import { triggeringVerdictFor, loadGoldenSet, validateGoldenSet } from '../src/corpus-eval';
import { classifySubstantiveQuestion } from '@risezome/engine/relevance';

describe('triggeringVerdictFor (U6) — eval triggering verdict', () => {
  it('AE7: a real question reads as the QUESTION lane and fires', () => {
    const v = triggeringVerdictFor('what ai models are used in the project');
    expect(v.lane).toBe('question');
    expect(v.isQuestion).toBe(true);
    expect(v.wouldFire).toBe(true);
  });

  it('AE7: filler / rhetorical reads as ambient and would NOT fire', () => {
    for (const t of ['right', 'you know what i mean', 'that makes sense, right', 'moving on']) {
      const v = triggeringVerdictFor(t);
      expect(v.lane).toBe('ambient');
      expect(v.wouldFire).toBe(false);
    }
  });

  it('R15: the verdict is computed from the SAME classifier the live path uses', () => {
    for (const t of ['how does reranking work', 'right', 'open the file', 'which embedding model']) {
      expect(triggeringVerdictFor(t).isQuestion).toBe(classifySubstantiveQuestion(t).isQuestion);
    }
  });

  it('R16: the golden set (with the new rhetorical examples) stays valid', () => {
    expect(validateGoldenSet(loadGoldenSet())).toEqual([]);
  });

  it('R16: at least one golden surfaces a would-NOT-fire verdict and one a would-fire', () => {
    const verdicts = loadGoldenSet().map((q) => triggeringVerdictFor(q.q));
    expect(verdicts.some((v) => !v.wouldFire)).toBe(true);
    expect(verdicts.some((v) => v.wouldFire)).toBe(true);
  });
});
