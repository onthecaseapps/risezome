import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rmSync, writeFile } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pullRepoFiles } from '../../../src/connectors/github/pull-files.js';
import type { AuthResult, ScopeDescriptor } from '../../../src/connectors/contract.js';

const mkdirAsync = promisify(mkdir);
const writeFileAsync = promisify(writeFile);

const TEST_AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };

function makeScope(repo = 'acme/widget'): ScopeDescriptor {
  return {
    id: repo,
    displayName: repo,
    type: 'github-repo',
    metadata: { url: `https://github.com/${repo}` },
  };
}

async function writeRepoFile(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  const parent = abs.slice(0, abs.lastIndexOf('/'));
  await mkdirAsync(parent, { recursive: true });
  await writeFileAsync(abs, content);
}

describe('pullRepoFiles', () => {
  let cacheDir: string;
  let fakeRepoDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'risezome-pull-cache-'));
    fakeRepoDir = await mkdtemp(join(tmpdir(), 'risezome-fake-repo-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(fakeRepoDir, { recursive: true, force: true });
  });

  it('emits one CanonicalDoc per file with stable IDs and provenance="untrusted"', async () => {
    await writeRepoFile(fakeRepoDir, 'README.md', '# Widget\n\nA test repo.');
    await writeRepoFile(fakeRepoDir, 'src/main.ts', 'export const a = 1;\n');

    const result = await pullRepoFiles(TEST_AUTH, makeScope(), {
      cacheDir,
      clonePath: fakeRepoDir,
    });

    expect(result.docs).toHaveLength(2);
    const byId = new Map(result.docs.map((d) => [d.id, d]));
    const readme = byId.get('gh:acme/widget#file:README.md');
    const code = byId.get('gh:acme/widget#file:src/main.ts');
    expect(readme?.type).toBe('doc');
    expect(code?.type).toBe('code-file');
    expect(readme?.provenance).toBe('untrusted');
    expect(readme?.url).toBe('https://github.com/acme/widget/blob/HEAD/README.md');
  });

  it('emits markdown chunks with domain=text and code chunks with domain=code', async () => {
    await writeRepoFile(
      fakeRepoDir,
      'README.md',
      '## Section\n\nThis is body content that is meaningfully long enough to clear the chunk-floor noise guard.',
    );
    await writeRepoFile(
      fakeRepoDir,
      'src/main.ts',
      'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n',
    );

    const result = await pullRepoFiles(TEST_AUTH, makeScope(), {
      cacheDir,
      clonePath: fakeRepoDir,
    });

    const mdChunks = result.chunks.filter((c) => c.docId.endsWith('README.md'));
    const codeChunks = result.chunks.filter((c) => c.docId.endsWith('main.ts'));
    expect(mdChunks.length).toBeGreaterThan(0);
    expect(mdChunks.every((c) => c.domain === 'text')).toBe(true);
    expect(codeChunks.length).toBeGreaterThan(0);
    expect(codeChunks.every((c) => c.domain === 'code')).toBe(true);
    // E: code chunk headers now include a `lang: <language>` tag.
    expect(codeChunks[0]!.text).toContain('(lang: typescript)');
  });

  it('prepends file:line headers to code chunks so retrieval shows location', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `let v${String(i)} = ${String(i)};`);
    await writeRepoFile(fakeRepoDir, 'src/big.ts', lines.join('\n'));

    const result = await pullRepoFiles(TEST_AUTH, makeScope(), {
      cacheDir,
      clonePath: fakeRepoDir,
    });

    const codeChunks = result.chunks.filter((c) => c.docId.endsWith('big.ts'));
    expect(codeChunks.length).toBeGreaterThan(0);
    codeChunks.forEach((c) => {
      expect(c.text).toMatch(/^\/\/ src\/big\.ts:\d+-\d+/);
    });
  });

  it('skips ignored directories during cloning walk', async () => {
    await writeRepoFile(fakeRepoDir, 'node_modules/x/x.js', 'noise');
    await writeRepoFile(fakeRepoDir, '.git/HEAD', 'ref');
    await writeRepoFile(fakeRepoDir, 'dist/out.js', 'noise');
    await writeRepoFile(fakeRepoDir, 'src/keep.ts', 'export const a = 1;');

    const result = await pullRepoFiles(TEST_AUTH, makeScope(), {
      cacheDir,
      clonePath: fakeRepoDir,
    });

    const paths = result.docs.map((d) => d.id);
    expect(paths).toContain('gh:acme/widget#file:src/keep.ts');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('dist/'))).toBe(false);
    expect(paths.some((p) => p.includes('.git/'))).toBe(false);
  });
});
