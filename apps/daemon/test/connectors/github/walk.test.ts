import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rmSync, writeFile } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { classifyFile, walkRepoFiles } from '../../../src/connectors/github/walk.js';

const mkdirAsync = promisify(mkdir);
const writeFileAsync = promisify(writeFile);

describe('classifyFile', () => {
  it('identifies notable filenames as docs', () => {
    expect(classifyFile('README')).toBe('doc');
    expect(classifyFile('CONTRIBUTING.md')).toBe('doc');
    expect(classifyFile('AGENTS.md')).toBe('doc');
  });

  it('identifies code by extension', () => {
    expect(classifyFile('main.ts')).toBe('code');
    expect(classifyFile('main.go')).toBe('code');
    expect(classifyFile('script.sh')).toBe('code');
  });

  it('identifies docs by extension', () => {
    expect(classifyFile('intro.md')).toBe('doc');
    expect(classifyFile('intro.rst')).toBe('doc');
  });

  it('returns null for unrecognised files', () => {
    expect(classifyFile('image.png')).toBeNull();
    expect(classifyFile('binary.exe')).toBeNull();
    expect(classifyFile('data.json')).toBeNull();
  });
});

describe('walkRepoFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'upwell-walk-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, content: string): Promise<void> {
    const abs = join(dir, rel);
    const parent = abs.slice(0, abs.lastIndexOf('/'));
    await mkdirAsync(parent, { recursive: true });
    await writeFileAsync(abs, content);
  }

  it('yields code and doc files, skipping unrecognised types', async () => {
    await writeFile('src/main.ts', 'export const a = 1;');
    await writeFile('docs/intro.md', '# Intro');
    await writeFile('LICENSE', 'MIT');
    await writeFile('image.png', '\x89PNG\r\n');

    const results: { relPath: string; kind: string }[] = [];
    for await (const f of walkRepoFiles(dir)) {
      results.push({ relPath: f.relPath, kind: f.kind });
    }
    const map = new Map(results.map((r) => [r.relPath, r.kind]));
    expect(map.get('src/main.ts')).toBe('code');
    expect(map.get('docs/intro.md')).toBe('doc');
    expect(map.get('LICENSE')).toBe('doc');
    expect(map.has('image.png')).toBe(false);
  });

  it('skips ignored directories', async () => {
    await writeFile('node_modules/x/index.js', 'noise');
    await writeFile('dist/main.js', 'noise');
    await writeFile('.git/HEAD', 'ref');
    await writeFile('src/keep.ts', 'export const a = 1;');

    const results: string[] = [];
    for await (const f of walkRepoFiles(dir)) {
      results.push(f.relPath);
    }
    expect(results).toContain('src/keep.ts');
    expect(results.some((r) => r.startsWith('node_modules/'))).toBe(false);
    expect(results.some((r) => r.startsWith('dist/'))).toBe(false);
    expect(results.some((r) => r.startsWith('.git/'))).toBe(false);
  });

  it('skips lockfiles and generated files', async () => {
    await writeFile('package-lock.json', '{}');
    await writeFile('pnpm-lock.yaml', '');
    await writeFile('app.min.js', 'minified');
    await writeFile('module.d.ts', 'declare const x: number;');
    await writeFile('src/main.ts', 'export const a = 1;');

    const results: string[] = [];
    for await (const f of walkRepoFiles(dir)) {
      results.push(f.relPath);
    }
    expect(results).toEqual(['src/main.ts']);
  });

  it('skips files exceeding maxFileBytes', async () => {
    const big = 'x'.repeat(10 * 1024);
    await writeFile('big.ts', big);
    await writeFile('small.ts', 'export const a = 1;');
    const results: string[] = [];
    for await (const f of walkRepoFiles(dir, { maxFileBytes: 1024 })) {
      results.push(f.relPath);
    }
    expect(results).toEqual(['small.ts']);
  });

  it('skips files containing null bytes (binary)', async () => {
    await writeFile('bin.ts', 'export const x = 1;\x00\x00\x00\x00still binary');
    await writeFile('text.ts', 'export const x = 1;');
    const results: string[] = [];
    for await (const f of walkRepoFiles(dir)) {
      results.push(f.relPath);
    }
    expect(results).toEqual(['text.ts']);
  });

  it('honors maxFiles cap', async () => {
    for (let i = 0; i < 20; i++) {
      await writeFile(`f${String(i)}.ts`, `export const x = ${String(i)};`);
    }
    const results: string[] = [];
    for await (const f of walkRepoFiles(dir, { maxFiles: 5 })) {
      results.push(f.relPath);
    }
    expect(results).toHaveLength(5);
  });
});
