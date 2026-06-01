import { describe, expect, it, vi } from 'vitest';
import {
  contextualizeChunks,
  contextualizedText,
  type ContextGenerator,
} from '../../src/contextualize/contextualize.js';

describe('contextualizedText', () => {
  it('prepends context to the body when present', () => {
    expect(contextualizedText('From the README, about the stack.', 'We use X.')).toBe(
      'From the README, about the stack.\n\nWe use X.',
    );
  });
  it('returns the body unchanged when context is empty', () => {
    expect(contextualizedText('', 'We use X.')).toBe('We use X.');
  });
});

describe('contextualizeChunks', () => {
  it('generates a context per chunk, trimmed', async () => {
    const gen: ContextGenerator = vi.fn(async (_doc, chunk) => `  ctx:${chunk}  `);
    const out = await contextualizeChunks('full doc', ['a', 'b'], gen);
    expect(out).toEqual(['ctx:a', 'ctx:b']);
  });

  it('skips empty/whitespace chunks without calling the generator', async () => {
    const gen = vi.fn(async () => 'ctx');
    const out = await contextualizeChunks('doc', ['  ', 'real'], gen);
    expect(out).toEqual(['', 'ctx']);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty context when the generator throws (chunk still indexed body-only)', async () => {
    const gen: ContextGenerator = async (_doc, chunk) => {
      if (chunk === 'boom') throw new Error('llm 500');
      return 'ctx';
    };
    const out = await contextualizeChunks('doc', ['ok', 'boom', 'ok2'], gen);
    expect(out).toEqual(['ctx', '', 'ctx']);
  });

  it('passes the full document to the generator (cache-block source)', async () => {
    const gen = vi.fn(async () => 'ctx');
    await contextualizeChunks('THE WHOLE DOC', ['chunk'], gen);
    expect(gen).toHaveBeenCalledWith('THE WHOLE DOC', 'chunk');
  });
});
