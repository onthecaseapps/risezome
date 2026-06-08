import { describe, expect, it } from 'vitest';
import {
  buildClassifierSystem,
  buildClassifierUserMessage,
  CLASSIFIER_SYSTEM_PROMPT,
  HAIKU_CACHE_MIN_CHAR_PROXY,
} from '../../src/router/prompt.js';

describe('buildClassifierSystem', () => {
  it('returns a single text block with cache_control: ephemeral', () => {
    const blocks = buildClassifierSystem();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('text length clears the ≥4096-token cacheable-prefix proxy (16k chars)', () => {
    const blocks = buildClassifierSystem();
    expect(blocks[0]!.text.length).toBeGreaterThanOrEqual(HAIKU_CACHE_MIN_CHAR_PROXY);
  });

  it('includes at least one positive example per v1 GitHub skill', () => {
    const text = buildClassifierSystem()[0]!.text;
    for (const name of [
      'github_count',
      'github_list',
      'github_recently_updated',
      'github_by_author',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('includes at least one refusal (respond with text) example', () => {
    const text = buildClassifierSystem()[0]!.text;
    const refusalMarkers = text.match(/respond with text/gi) ?? [];
    expect(refusalMarkers.length).toBeGreaterThanOrEqual(2);
  });

  it('CLASSIFIER_SYSTEM_PROMPT matches the block text', () => {
    expect(buildClassifierSystem()[0]!.text).toBe(CLASSIFIER_SYSTEM_PROMPT);
  });
});

describe('buildClassifierUserMessage — recent-finals context (U1)', () => {
  it('no context → bare utterance (back-compat)', () => {
    expect(buildClassifierUserMessage('how many of these issues are there')).toBe(
      'how many of these issues are there',
    );
  });

  it('summary-only render is unchanged by the finals addition (characterization)', () => {
    const out = buildClassifierUserMessage('how many of these', {
      current_topic: 'github issues',
      open_questions: ['are there open bugs?'],
    });
    expect(out).toContain('Meeting context so far:');
    expect(out).toContain('- Current topic: github issues');
    expect(out).toContain('- Open questions:');
    expect(out).toContain('    "are there open bugs?"');
    expect(out).not.toContain('Recent turns'); // no finals → no finals block
    expect(out).toContain('Utterance: how many of these');
  });

  it('finals-only → the preamble fires with a Recent turns block (no summary lines)', () => {
    const out = buildClassifierUserMessage('how many of these issues are there', {
      recent_finals: ['are there any open github issues'],
    });
    expect(out).toContain('Meeting context so far:');
    expect(out).toContain('- Recent turns (most recent last):');
    expect(out).toContain('    "are there any open github issues"');
    expect(out).not.toContain('- Current topic:');
    expect(out).not.toContain('- Open questions:');
    expect(out).toContain('Utterance: how many of these issues are there');
  });

  it('summary + finals → both blocks present, finals labeled distinctly', () => {
    const out = buildClassifierUserMessage('how many of these', {
      current_topic: 'transcript capture',
      recent_finals: ['are there any open github issues'],
    });
    expect(out).toContain('- Current topic: transcript capture');
    expect(out).toContain('- Recent turns (most recent last):');
    expect(out).toContain('    "are there any open github issues"');
  });

  it('preserves order (most recent last) and verbatim text', () => {
    const out = buildClassifierUserMessage('and how many', {
      recent_finals: ['first turn', 'second turn', 'third turn'],
    });
    expect(out.indexOf('"first turn"')).toBeLessThan(out.indexOf('"second turn"'));
    expect(out.indexOf('"second turn"')).toBeLessThan(out.indexOf('"third turn"'));
  });

  it('empty recent_finals: [] is treated as absent (no block, no bare-utterance regression)', () => {
    expect(buildClassifierUserMessage('utterance', { recent_finals: [] })).toBe('utterance');
  });
});
