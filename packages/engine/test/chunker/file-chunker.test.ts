import { describe, expect, it } from 'vitest';
import { chunkFile, classifyFile } from '../../src/chunker/file-chunker.js';

describe('classifyFile', () => {
  it('classifies code by extension', () => {
    expect(classifyFile('src/foo.ts')).toBe('code');
    expect(classifyFile('lib/bar.py')).toBe('code');
    expect(classifyFile('App.tsx')).toBe('code');
    expect(classifyFile('config.yaml')).toBe('code');
  });

  it('classifies prose extensions as text', () => {
    expect(classifyFile('README.md')).toBe('text');
    expect(classifyFile('docs/intro.mdx')).toBe('text');
    expect(classifyFile('NOTES.txt')).toBe('text');
  });

  it('recognises filename-only code hints', () => {
    expect(classifyFile('Dockerfile')).toBe('code');
    expect(classifyFile('apps/web/Makefile')).toBe('code');
    expect(classifyFile('rakefile')).toBe('code');
  });

  it('returns null for binary and unknown extensions', () => {
    expect(classifyFile('logo.png')).toBeNull();
    expect(classifyFile('archive.zip')).toBeNull();
    expect(classifyFile('font.woff2')).toBeNull();
    expect(classifyFile('mystery.xyz')).toBeNull();
    expect(classifyFile('no-extension')).toBeNull();
  });
});

describe('chunkFile', () => {
  it('skips files that cannot be classified', () => {
    expect(chunkFile('logo.png', 'binary data')).toEqual([]);
    expect(chunkFile('mystery.xyz', 'whatever')).toEqual([]);
  });

  it('skips empty files', () => {
    expect(chunkFile('README.md', '')).toEqual([]);
  });

  it('returns a single chunk for short text files', () => {
    const chunks = chunkFile('README.md', '# Hello\n\nWorld');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.domain).toBe('text');
    expect(chunks[0]?.position).toBe(0);
    expect(chunks[0]?.text).toContain('# Hello');
  });

  it('emits multiple overlapping chunks when content exceeds chunk size', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const chunks = chunkFile('big.md', lines.join('\n'), {
      textChunkLines: 50,
      overlapLines: 10,
    });
    // stride = 50 - 10 = 40; positions 0, 40, 80, 120, 160 (5 chunks)
    expect(chunks).toHaveLength(5);
    expect(chunks.map((c) => c.position)).toEqual([0, 1, 2, 3, 4]);
    // Overlap: first chunk ends at line 49; second chunk starts at line 40
    expect(chunks[1]?.text.split('\n')[0]).toBe('line 40');
    expect(chunks[0]?.text.split('\n').slice(-1)[0]).toBe('line 49');
  });

  it('uses code chunk size for code files', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `const x${i} = ${i};`);
    const chunks = chunkFile('src/foo.ts', lines.join('\n'), {
      codeChunkLines: 60,
      overlapLines: 10,
    });
    // stride = 50, so positions 0, 50, 100 → 3 chunks
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.domain).toBe('code');
  });

  it('rejects oversized files', () => {
    const big = 'x'.repeat(1024 * 1024); // 1 MB
    expect(chunkFile('big.md', big, { maxFileBytes: 512 * 1024 })).toEqual([]);
  });

  it('drops chunks that are only whitespace', () => {
    const content = ['real content', '', '', '', '', '', '', '', '', '', ''].join('\n');
    const chunks = chunkFile('foo.md', content, { textChunkLines: 5, overlapLines: 0 });
    // First chunk has 'real content'; subsequent windows are whitespace-only and skipped.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('real content');
  });
});
