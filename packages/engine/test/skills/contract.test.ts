import { describe, expect, it } from 'vitest';
import {
  formatAsSource,
  SkillExecutionError,
  SkillUnknownError,
  type SkillResult,
} from '../../src/skills/contract.js';

describe('formatAsSource', () => {
  it('renders a count result as title + summary, no items section', () => {
    const result: SkillResult = { kind: 'count', summary: '5 open issues.' };
    const source = formatAsSource(result, 'github_count', { state: 'open' });
    expect(source.rank).toBe(0);
    expect(source.title).toBe('Tool: github_count({"state":"open"})');
    expect(source.text).toBe('5 open issues.');
  });

  it('renders a list result with numbered items below the summary', () => {
    const result: SkillResult = {
      kind: 'list',
      summary: 'jamie has 2 open issues:',
      items: [
        { title: 'Auth refactor', url: 'https://github.com/x/y/issues/1', subtitle: '#1 · open' },
        { title: 'Deploy script bug', url: 'https://github.com/x/y/issues/2', subtitle: '#2 · open' },
      ],
    };
    const source = formatAsSource(result, 'github_by_author', { author: 'jamie' });
    expect(source.text).toBe(
      'jamie has 2 open issues:\n' +
        '\n' +
        '#1: Auth refactor — #1 · open (https://github.com/x/y/issues/1)\n' +
        '#2: Deploy script bug — #2 · open (https://github.com/x/y/issues/2)',
    );
  });

  it('omits the subtitle when not provided', () => {
    const result: SkillResult = {
      kind: 'list',
      summary: 'Two items:',
      items: [
        { title: 'A', url: 'https://x/1' },
        { title: 'B' },
      ],
    };
    const source = formatAsSource(result, 'x', {});
    expect(source.text).toContain('#1: A (https://x/1)');
    expect(source.text).toContain('#2: B');
    expect(source.text).not.toContain('—');
  });

  it('omits the url when not provided', () => {
    const result: SkillResult = {
      kind: 'list',
      summary: 'One item:',
      items: [{ title: 'A', subtitle: 'sub' }],
    };
    const source = formatAsSource(result, 'x', {});
    expect(source.text).toBe('One item:\n\n#1: A — sub');
  });

  it('treats empty items array as no list section', () => {
    const result: SkillResult = {
      kind: 'list',
      summary: 'Nothing here.',
      items: [],
    };
    const source = formatAsSource(result, 'x', {});
    expect(source.text).toBe('Nothing here.');
  });

  it('serializes args via JSON.stringify into the title (stable shape)', () => {
    const source = formatAsSource(
      { kind: 'count', summary: '0.' },
      'fn',
      { a: 1, b: 'two', c: ['x', 'y'] },
    );
    expect(source.title).toBe('Tool: fn({"a":1,"b":"two","c":["x","y"]})');
  });
});

describe('SkillExecutionError', () => {
  it('defaults executionCode to "execution-error" when not provided', () => {
    const err = new SkillExecutionError('github_count', 'corpus offline');
    expect(err.skillName).toBe('github_count');
    expect(err.executionCode).toBe('execution-error');
    expect(err.code).toBe('skill-execution');
  });

  it('honors the executionCode option', () => {
    const err = new SkillExecutionError('github_count', 'rate limited', {
      executionCode: 'rate-limit',
    });
    expect(err.executionCode).toBe('rate-limit');
  });
});

describe('SkillUnknownError', () => {
  it('captures the skill name and a stable error code', () => {
    const err = new SkillUnknownError('github_nonexistent');
    expect(err.skillName).toBe('github_nonexistent');
    expect(err.code).toBe('skill-unknown');
    expect(err.message).toContain('github_nonexistent');
  });
});
