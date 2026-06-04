import { describe, expect, it } from 'vitest';
import { classifySubstantiveQuestion } from '../../src/relevance/substantive-question.js';

const isQ = (t: string): boolean => classifySubstantiveQuestion(t).isQuestion;

describe('classifySubstantiveQuestion', () => {
  describe('genuine questions (isQuestion: true)', () => {
    it('interrogative-word questions, even without a question mark (live ASR drops punctuation)', () => {
      // The motivating incident: transcribed with no "?".
      expect(isQ('what ai models do we use')).toBe(true);
      expect(isQ('how does retrieval rank chunks')).toBe(true);
      expect(isQ('which embedding model do we use')).toBe(true);
      expect(isQ('why did the build fail')).toBe(true);
    });

    it('questions with a question mark', () => {
      expect(isQ('how does the cooldown work?')).toBe(true);
      expect(isQ('can you explain the gate?')).toBe(true);
    });

    it('info-seeking imperative requests', () => {
      // Design decision: imperative info-requests ARE questions (the user
      // wants an answer from the corpus). Asserted explicitly.
      expect(isQ('tell me how the cooldown works')).toBe(true);
      expect(isQ('explain the relevance gate')).toBe(true);
      expect(isQ('find the issues filed by jamie')).toBe(true);
      expect(isQ('remind me what the ceiling default is')).toBe(true);
    });

    it('terse but real questions', () => {
      expect(isQ('which model')).toBe(true);
      expect(isQ('what is the cooldown')).toBe(true);
    });
  });

  describe('rhetorical / not real questions (isQuestion: false)', () => {
    it('standalone rhetorical tags (AE3)', () => {
      expect(isQ('right?')).toBe(false);
      expect(isQ('you know?')).toBe(false);
      expect(isQ('you know what i mean?')).toBe(false);
      expect(isQ('makes sense?')).toBe(false);
    });

    it('substantive statement with a trailing rhetorical tag (AE3)', () => {
      expect(isQ('that makes sense, right?')).toBe(false);
      expect(isQ("we're shipping it tomorrow, you know?")).toBe(false);
    });
  });

  describe('filler (isQuestion: false)', () => {
    it('acknowledgments and meta-filler', () => {
      for (const t of ['yeah', 'ok', 'hmm', 'where were we', 'moving on', 'got it']) {
        expect(isQ(t)).toBe(false);
      }
    });
  });

  describe('statements and commands (isQuestion: false)', () => {
    it('bare statements', () => {
      expect(isQ('the build is green')).toBe(false);
      expect(isQ('we deploy on fridays')).toBe(false);
    });

    it('action imperatives (commands, not info requests)', () => {
      expect(isQ('open the file')).toBe(false);
      expect(isQ('close the ticket')).toBe(false);
    });

    it('a bare filename mention is not a question', () => {
      expect(isQ('look at retrieval.ts')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('empty / whitespace / non-string', () => {
      expect(isQ('')).toBe(false);
      expect(isQ('   ')).toBe(false);
      // @ts-expect-error runtime guard
      expect(isQ(undefined)).toBe(false);
    });

    it('one-word clarifications are not substantive questions', () => {
      expect(isQ('what?')).toBe(false);
      expect(isQ('how?')).toBe(false);
    });

    it('returns a reason string for debug/eval display', () => {
      expect(classifySubstantiveQuestion('what ai models do we use').reason).toMatch(/\S/);
      expect(classifySubstantiveQuestion('yeah').reason).toMatch(/\S/);
    });
  });
});
