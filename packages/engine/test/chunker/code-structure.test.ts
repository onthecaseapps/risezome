import { describe, expect, it } from 'vitest';
import { chunkFile } from '../../src/chunker/file-chunker.js';
import { dialectForExt, findUnitBoundaries } from '../../src/chunker/code-structure.js';

const opts = { codeStructureAware: true, codeChunkLines: 120, overlapLines: 20 };

describe('dialectForExt', () => {
  it('maps major language extensions to dialects', () => {
    expect(dialectForExt('ts')).toBe('ts');
    expect(dialectForExt('tsx')).toBe('ts');
    expect(dialectForExt('py')).toBe('python');
    expect(dialectForExt('go')).toBe('go');
    expect(dialectForExt('rs')).toBe('rust');
    expect(dialectForExt('java')).toBe('jvm');
    expect(dialectForExt('kt')).toBe('jvm');
    expect(dialectForExt('cs')).toBe('csharp');
    expect(dialectForExt('cpp')).toBe('cfamily');
    expect(dialectForExt('rb')).toBe('ruby');
    expect(dialectForExt('php')).toBe('php');
    expect(dialectForExt('swift')).toBe('swift');
  });

  it('returns null for languages without heuristics', () => {
    expect(dialectForExt('css')).toBeNull();
    expect(dialectForExt('sql')).toBeNull();
    expect(dialectForExt('yaml')).toBeNull();
    expect(dialectForExt('md')).toBeNull();
  });
});

describe('findUnitBoundaries', () => {
  it('always includes 0 and stays sorted/unique', () => {
    const b = findUnitBoundaries(['const a = 1', 'const b = 2'], 'ts');
    expect(b[0]).toBe(0);
    expect(b).toEqual([...b].sort((x, y) => x - y));
    expect(new Set(b).size).toBe(b.length);
  });

  it('splits TypeScript on top-level declarations, not body lines', () => {
    const lines = [
      'import { x } from "y";',
      '',
      'export function foo() {',
      '  const inner = 1;', // indented body — never a boundary
      '  return inner;',
      '}',
      '',
      'class Bar {',
      '  method() {}',
      '}',
    ];
    const b = findUnitBoundaries(lines, 'ts');
    expect(b).toContain(2); // export function foo
    expect(b).toContain(7); // class Bar
    expect(b).not.toContain(3); // indented body line
    expect(b).not.toContain(4);
  });

  it('attaches a leading doc-comment block to the declaration below it', () => {
    const lines = [
      'const top = 1;',
      '',
      '/** does a thing */',
      '// more detail',
      'export function foo() {}',
    ];
    const b = findUnitBoundaries(lines, 'ts');
    // The boundary is the comment start (line 2), not the function (line 4).
    expect(b).toContain(2);
    expect(b).not.toContain(4);
  });

  it('absorbs decorators into the following declaration (python)', () => {
    const lines = [
      'x = 1',
      '',
      '@decorator',
      'def handler():',
      '    pass',
    ];
    const b = findUnitBoundaries(lines, 'python');
    expect(b).toContain(2); // @decorator
    expect(b).not.toContain(3); // def handler
  });

  it('does not treat dangling closers as boundaries', () => {
    const lines = [
      'promise',
      '  .then(x => x)',
      '}', // col-0 closer
      ').catch(e => e)',
    ];
    const b = findUnitBoundaries(lines, 'ts');
    expect(b).toEqual([0]);
  });

  it('does not treat # as a comment in C-family (preprocessor)', () => {
    const lines = [
      '#include <stdio.h>',
      '',
      'int main(void) {',
      '  return 0;',
      '}',
    ];
    const b = findUnitBoundaries(lines, 'cfamily');
    expect(b).toContain(0);
    expect(b).toContain(2); // int main(
  });
});

describe('chunkFile structure-aware emission', () => {
  it('keeps a whole small function in one chunk', () => {
    const src = [
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
    ].join('\n');
    const chunks = chunkFile('src/math.ts', src, opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('export function add');
    expect(chunks[0]!.text).toContain('return a + b');
    expect(chunks[0]!.domain).toBe('code');
  });

  it('bin-packs several tiny declarations into one chunk', () => {
    const src = [
      'export const a = 1;',
      'export const b = 2;',
      'export const c = 3;',
      'export const d = 4;',
    ].join('\n');
    const chunks = chunkFile('src/consts.ts', src, opts);
    // Well under the 120-line budget → a single packed chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain('a = 1');
    expect(chunks[0]!.text).toContain('d = 4');
  });

  it('line-windows an oversized single function', () => {
    const body = Array.from({ length: 300 }, (_, i) => `  const v${String(i)} = ${String(i)};`);
    const src = ['export function huge() {', ...body, '}'].join('\n');
    const chunks = chunkFile('src/huge.ts', src, { ...opts, codeChunkLines: 120, overlapLines: 20 });
    // 302 lines / stride 100 → multiple windowed chunks, none over budget.
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.split('\n').length).toBeLessThanOrEqual(120);
    }
  });

  it('separates two adjacent functions into distinct chunks when packing would exceed budget', () => {
    const fnA = ['export function a() {', ...Array.from({ length: 90 }, () => '  noop();'), '}'];
    const fnB = ['export function b() {', ...Array.from({ length: 90 }, () => '  noop();'), '}'];
    const chunks = chunkFile('src/two.ts', [...fnA, ...fnB].join('\n'), opts);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.text).toContain('function a');
    expect(chunks.some((c) => c.text.includes('function b'))).toBe(true);
  });

  it('falls back to line windowing for unsupported code languages', () => {
    const src = Array.from({ length: 200 }, (_, i) => `.cls${String(i)} { color: red; }`).join('\n');
    const cssChunks = chunkFile('styles/app.css', src, opts);
    // CSS has no dialect → windowed; 200 lines / stride 100 → 2 chunks.
    expect(cssChunks.length).toBeGreaterThan(1);
  });

  it('off by default: line-windows code when codeStructureAware is unset', () => {
    const body = Array.from({ length: 200 }, (_, i) => `  const v${String(i)} = ${String(i)};`);
    const src = ['export function huge() {', ...body, '}'].join('\n');
    const windowed = chunkFile('src/x.ts', src); // no opts → off
    const structured = chunkFile('src/x.ts', src, opts);
    // Both produce chunks; the point is the default path doesn't throw and
    // ignores structure (it would split mid-function on the 120-line grid).
    expect(windowed.length).toBeGreaterThan(0);
    expect(structured.length).toBeGreaterThan(0);
  });

  it('never emits a chunk over MAX_CHUNK_CHARS', () => {
    const giant = 'x'.repeat(50000); // one absurd minified line
    const src = ['export const data =', `  "${giant}";`].join('\n');
    const chunks = chunkFile('src/blob.ts', src, opts);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(8000);
    }
  });
});
