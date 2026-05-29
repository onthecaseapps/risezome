import { describe, expect, it } from 'vitest';
import {
  buildClassifierSystem,
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
