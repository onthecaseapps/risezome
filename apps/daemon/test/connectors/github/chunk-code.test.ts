import { describe, expect, it } from 'vitest';
import { chunkCode } from '../../../src/connectors/github/chunk-code.js';

describe('chunkCode', () => {
  it('returns empty for empty input', () => {
    expect(chunkCode('')).toEqual([]);
  });

  it('returns a single chunk for short content', () => {
    const code = 'function foo() {\n  return 1;\n}\n';
    const chunks = chunkCode(code);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(4);
  });

  it('splits into multiple overlapping chunks for large files', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)}`);
    const chunks = chunkCode(lines.join('\n'), { chunkLines: 50, overlapLines: 10 });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(50);
    // Second chunk starts within the overlap region (line 41) of the first.
    expect(chunks[1]?.startLine).toBe(41);
  });

  it('marks startLine and endLine as 1-indexed inclusive', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${String(i)}`);
    const chunks = chunkCode(lines.join('\n'), { chunkLines: 10, overlapLines: 0 });
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(10);
    expect(chunks[1]?.startLine).toBe(11);
    expect(chunks[1]?.endLine).toBe(20);
  });

  it('handles whitespace-only chunks by dropping them', () => {
    const code = ['function a() {}', '', '', '', ''].join('\n');
    const chunks = chunkCode(code, { chunkLines: 1, overlapLines: 0 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('function a() {}');
  });
});
