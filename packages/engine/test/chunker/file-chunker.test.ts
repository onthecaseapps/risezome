import { describe, expect, it } from 'vitest';
import { chunkFile, classifyFile, MAX_CHUNK_CHARS } from '../../src/chunker/file-chunker.js';

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

  it('skips content containing NUL bytes (binary disguised under a text extension)', () => {
    expect(chunkFile('blob.json', 'looks like text\u0000but is binary')).toEqual([]);
    expect(chunkFile('README.md', 'abc\u0000def')).toEqual([]);
  });

  it('hard-splits a single oversized line so no chunk exceeds MAX_CHUNK_CHARS', () => {
    // One-line "minified" file: 3.5x the cap on a single line.
    const oneLine = 'x'.repeat(Math.floor(MAX_CHUNK_CHARS * 3.5));
    const chunks = chunkFile('bundle.min.js', oneLine);
    expect(chunks.length).toBe(4);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // No content lost and positions stay sequential.
    expect(chunks.map((c) => c.position)).toEqual([0, 1, 2, 3]);
    expect(chunks.reduce((n, c) => n + c.text.length, 0)).toBe(oneLine.length);
  });

  it('hard-splits an over-cap multi-line window (many long lines)', () => {
    const lines = Array.from({ length: 10 }, () => 'y'.repeat(1500));
    const chunks = chunkFile('long-lines.md', lines.join('\n'), { textChunkLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it('drops chunks that are only whitespace', () => {
    const content = ['real content', '', '', '', '', '', '', '', '', '', ''].join('\n');
    const chunks = chunkFile('foo.md', content, { textChunkLines: 5, overlapLines: 0 });
    // First chunk has 'real content'; subsequent windows are whitespace-only and skipped.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('real content');
  });
});
