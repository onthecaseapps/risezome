import { describe, expect, it } from 'vitest';
import {
  classifyRelevanceHeuristic,
  normalizeForRelevance,
  FILLER_PATTERNS,
  SUBSTANTIVE_PATTERNS,
  SUBSTANTIVE_MIN_LENGTH,
} from '../../src/relevance/heuristic.js';

describe('classifyRelevanceHeuristic', () => {
  describe('clearly_filler', () => {
    it('single-word acknowledgments', () => {
      for (const word of ['yeah', 'yes', 'no', 'ok', 'okay', 'right', 'sure', 'cool', 'hmm', 'mm-hm', 'uh-huh', 'got it']) {
        expect(classifyRelevanceHeuristic(word)).toBe('clearly_filler');
      }
    });

    it('stock filler phrases as whole utterances', () => {
      expect(classifyRelevanceHeuristic('let me think')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic("that makes sense")).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('good point')).toBe('clearly_filler');
    });

    it('social pleasantries', () => {
      expect(classifyRelevanceHeuristic('hi')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('thanks')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('thank you')).toBe('clearly_filler');
    });

    it('meta-meeting talk', () => {
      expect(classifyRelevanceHeuristic('where were we')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('moving on')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('next item')).toBe('clearly_filler');
    });

    it('empty and whitespace-only strings', () => {
      expect(classifyRelevanceHeuristic('')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('   ')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('\n\t')).toBe('clearly_filler');
    });

    it('case-insensitive — "YEAH" returns clearly_filler', () => {
      expect(classifyRelevanceHeuristic('YEAH')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('Yeah')).toBe('clearly_filler');
    });

    it('trailing punctuation — "yeah." and "yeah!" both return clearly_filler', () => {
      expect(classifyRelevanceHeuristic('yeah.')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('yeah!')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('OK!')).toBe('clearly_filler');
      expect(classifyRelevanceHeuristic('Thanks.')).toBe('clearly_filler');
    });

    it('non-string input', () => {
      // @ts-expect-error testing runtime safety
      expect(classifyRelevanceHeuristic(undefined)).toBe('clearly_filler');
      // @ts-expect-error testing runtime safety
      expect(classifyRelevanceHeuristic(null)).toBe('clearly_filler');
    });
  });

  describe('clearly_substantive', () => {
    it('contains a question mark', () => {
      expect(classifyRelevanceHeuristic('how does the rag pipeline work?')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('really?')).toBe('clearly_substantive');
    });

    it('starts with an interrogative word', () => {
      for (const word of ['how', 'what', 'why', 'where', 'when', 'which', 'who', 'can', 'should', 'is', 'are', 'do', 'does']) {
        expect(classifyRelevanceHeuristic(`${word} does this work`)).toBe('clearly_substantive');
      }
    });

    it('starts with an imperative request form', () => {
      expect(classifyRelevanceHeuristic('tell me about the rag pipeline')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('show me the auth tests')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('walk me through the embed flow')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('explain how voyage chunks docs')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('find issues by jamie')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('pull up issue 14')).toBe('clearly_substantive');
    });

    it('long utterance reaches the SUBSTANTIVE_MIN_LENGTH threshold', () => {
      // 80+ chars — even if no other substance marker matches, it's substantive.
      const long = 'the team had a long discussion about how to handle this case and the tradeoffs involved';
      expect(long.length).toBeGreaterThanOrEqual(SUBSTANTIVE_MIN_LENGTH);
      expect(classifyRelevanceHeuristic(long)).toBe('clearly_substantive');
    });

    it('path-like tokens and file extensions', () => {
      expect(classifyRelevanceHeuristic('check apps/daemon/src/auth.ts')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('the auth.ts file is broken')).toBe('clearly_substantive');
      expect(classifyRelevanceHeuristic('look at README.md')).toBe('clearly_substantive');
    });

    it('backticks signal a referenced identifier', () => {
      expect(classifyRelevanceHeuristic('the `evaluate` method')).toBe('clearly_substantive');
    });

    it('long pure-filler hits ≥80 threshold and returns clearly_substantive (known tradeoff)', () => {
      // Documented in Risks: long social filler will over-surface. The
      // ≥80-char rule is intentional. Test pins the behavior so a future
      // change is deliberate.
      const longFiller = 'oh wait no I totally hear you that was the same thing I was just thinking earlier today before this call';
      expect(longFiller.length).toBeGreaterThanOrEqual(SUBSTANTIVE_MIN_LENGTH);
      expect(classifyRelevanceHeuristic(longFiller)).toBe('clearly_substantive');
    });
  });

  describe('ambiguous', () => {
    it('"yeah so the auth thing is broken" is ambiguous (filler prefix + substantive content)', () => {
      // Documented in the plan: filler prefix doesn't disqualify, but
      // there's no clearly_substantive marker either, so it falls to
      // ambiguous and the LLM gets to decide.
      const utterance = 'yeah so the auth thing is broken';
      expect(utterance.length).toBeLessThan(SUBSTANTIVE_MIN_LENGTH);
      expect(classifyRelevanceHeuristic(utterance)).toBe('ambiguous');
    });

    it('short non-question statements are ambiguous', () => {
      expect(classifyRelevanceHeuristic('the deploy went sideways')).toBe('ambiguous');
      expect(classifyRelevanceHeuristic('we need a new approach')).toBe('ambiguous');
    });
  });

  describe('SUBSTANTIVE_MIN_LENGTH boundary', () => {
    it('utterance of exactly 79 chars with no other markers is ambiguous', () => {
      // 79 a-chars
      const seventyNine = 'a'.repeat(79);
      expect(seventyNine.length).toBe(79);
      expect(classifyRelevanceHeuristic(seventyNine)).toBe('ambiguous');
    });

    it('utterance of 80 chars is clearly_substantive', () => {
      const eighty = 'a'.repeat(80);
      expect(eighty.length).toBe(80);
      expect(classifyRelevanceHeuristic(eighty)).toBe('clearly_substantive');
    });
  });

  describe('pattern exports', () => {
    it('FILLER_PATTERNS contains non-empty regex set', () => {
      expect(FILLER_PATTERNS.length).toBeGreaterThan(0);
      for (const p of FILLER_PATTERNS) expect(p).toBeInstanceOf(RegExp);
    });

    it('SUBSTANTIVE_PATTERNS contains non-empty regex set', () => {
      expect(SUBSTANTIVE_PATTERNS.length).toBeGreaterThan(0);
      for (const p of SUBSTANTIVE_PATTERNS) expect(p).toBeInstanceOf(RegExp);
    });
  });
});

describe('normalizeForRelevance', () => {
  it('lowercases', () => {
    expect(normalizeForRelevance('YEAH')).toBe('yeah');
    expect(normalizeForRelevance('Yeah')).toBe('yeah');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeForRelevance('  yeah  ')).toBe('yeah');
    expect(normalizeForRelevance('\tyeah\n')).toBe('yeah');
  });

  it('strips trailing terminal punctuation', () => {
    expect(normalizeForRelevance('yeah.')).toBe('yeah');
    expect(normalizeForRelevance('yeah!')).toBe('yeah');
    expect(normalizeForRelevance('yeah?')).toBe('yeah');
    expect(normalizeForRelevance('yeah,')).toBe('yeah');
  });

  it('preserves internal punctuation', () => {
    expect(normalizeForRelevance('how does X work?')).toBe('how does x work');
    expect(normalizeForRelevance('the auth.ts file')).toBe('the auth.ts file');
  });

  it('"Yeah!", "yeah.", "YEAH" all collide on the cache key', () => {
    const variants = ['Yeah!', 'yeah.', 'YEAH', '  yeah  ', 'Yeah?'];
    const normalized = variants.map(normalizeForRelevance);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('yeah');
  });

  it('non-string input returns empty string', () => {
    // @ts-expect-error testing runtime safety
    expect(normalizeForRelevance(undefined)).toBe('');
    // @ts-expect-error testing runtime safety
    expect(normalizeForRelevance(null)).toBe('');
  });
});
