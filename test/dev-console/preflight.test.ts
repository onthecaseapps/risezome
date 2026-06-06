import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsBuild, envState, runBuild, BUILT_PACKAGES } from '../../scripts/dev-console/preflight';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'preflight-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeFile(rel: string, body = 'x'): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  return p;
}

/** Build all three packages' dist + src so the tree is fully "built and fresh". */
function buildAllPackages(): void {
  for (const pkg of BUILT_PACKAGES) {
    writeFile(`packages/${pkg}/src/index.ts`, 'export const x = 1;');
    writeFile(`packages/${pkg}/dist/index.js`, 'exports.x = 1;');
  }
}

describe('needsBuild', () => {
  it('true when a package dist is missing (fresh checkout)', () => {
    writeFile('packages/engine/src/index.ts');
    // no dist/ → never built
    expect(needsBuild(root)).toBe(true);
  });

  it('false when every package dist exists and is newer than src', () => {
    buildAllPackages();
    // bump dist mtimes into the future so they're strictly newer than src
    const future = Date.now() / 1000 + 60;
    for (const pkg of BUILT_PACKAGES) {
      utimesSync(join(root, `packages/${pkg}/dist/index.js`), future, future);
    }
    expect(needsBuild(root)).toBe(false);
  });

  it('true when a package src is newer than its dist (stale)', () => {
    buildAllPackages();
    // make engine src newer than its dist
    const future = Date.now() / 1000 + 60;
    utimesSync(join(root, 'packages/engine/src/index.ts'), future, future);
    expect(needsBuild(root)).toBe(true);
  });
});

describe('envState', () => {
  it('active present when both generated env files exist', () => {
    writeFile('apps/bot-worker/.env');
    writeFile('apps/portal/.env.local');
    const s = envState(root);
    expect(s.activePresent).toBe(true);
  });

  it('reports missing secrets when no .env.dev exist', () => {
    const s = envState(root);
    expect(s.activePresent).toBe(false);
    expect(s.secretsPresent).toBe(false);
    expect(s.missingSecrets.length).toBe(2);
  });

  it('secretsPresent (can generate) when both .env.dev exist but active is missing', () => {
    writeFile('apps/portal/.env.dev');
    writeFile('apps/bot-worker/.env.dev');
    const s = envState(root);
    expect(s.activePresent).toBe(false);
    expect(s.secretsPresent).toBe(true);
    expect(s.missingSecrets).toEqual([]);
  });
});

describe('runBuild', () => {
  it('streams output and resolves with the exit code (success)', async () => {
    const lines: string[] = [];
    const code = await runBuild(root, (l) => lines.push(l), {
      command: 'node',
      args: ['-e', "console.log('built ok')"],
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/built ok/);
  });

  it('resolves non-zero on a failing build', async () => {
    const code = await runBuild(root, () => undefined, {
      command: 'node',
      args: ['-e', 'process.exit(3)'],
    });
    expect(code).toBe(3);
  });
});
