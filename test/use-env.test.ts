import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests scripts/use-env.sh by running it against a throwaway repo ROOT. The
 * script derives ROOT from its own location, so copying it into a temp tree
 * makes it operate entirely there.
 */

const REAL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'use-env.sh');

let root: string;
let script: string;

function portalDevContents(): string {
  return [
    'NEXT_PUBLIC_SUPABASE_URL=https://hosted-ref.supabase.co',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_hosted',
    'SUPABASE_SECRET_KEY=sb_secret_hosted_VALUE',
    'BOT_WORKER_SECRET=shared-secret',
  ].join('\n') + '\n';
}
function botDevContents(): string {
  return ['SUPABASE_URL=https://hosted-ref.supabase.co', 'SUPABASE_SECRET_KEY=sb_secret_hosted_VALUE', 'BOT_WORKER_SECRET=shared-secret'].join('\n') + '\n';
}

function seedTree(): void {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'apps', 'portal'), { recursive: true });
  mkdirSync(join(root, 'apps', 'bot-worker'), { recursive: true });
  copyFileSync(REAL_SCRIPT, join(root, 'scripts', 'use-env.sh'));
  writeFileSync(join(root, 'apps', 'portal', '.env.dev'), portalDevContents());
  writeFileSync(join(root, 'apps', 'bot-worker', '.env.dev'), botDevContents());
}

function run(args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf8',
      // Run from a dir with no supabase/config.toml so `supabase status` (if the
      // CLI is installed) fails and the script uses the baked local keys.
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? '') };
  }
}

function readActive(file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'use-env-'));
  script = join(root, 'scripts', 'use-env.sh');
  seedTree();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('use-env.sh', () => {
  it('local mode: overrides Supabase with local stack + injects tag-derived hostnames', () => {
    const { status } = run(['nathan', 'local']);
    expect(status).toBe(0);
    const portal = readActive('apps/portal/.env.local');
    expect(portal).toContain('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321');
    expect(portal).toContain('RISEZOME_DEV_ORIGIN=dev-nathan.risezome.app');
    expect(portal).toContain('BOT_WORKER_BASE_URL=wss://bot-worker-dev-nathan.risezome.app');
    const bot = readActive('apps/bot-worker/.env');
    expect(bot).toContain('SUPABASE_URL=http://127.0.0.1:54321');
    expect(readFileSync(join(root, '.dev-tag'), 'utf8').trim()).toBe('nathan');
  });

  it('hosted mode: keeps the dev\'s hosted Supabase creds, still injects hostnames', () => {
    const { status } = run(['nathan', 'hosted']);
    expect(status).toBe(0);
    const portal = readActive('apps/portal/.env.local');
    expect(portal).toContain('NEXT_PUBLIC_SUPABASE_URL=https://hosted-ref.supabase.co');
    expect(portal).toContain('RISEZOME_DEV_ORIGIN=dev-nathan.risezome.app');
  });

  it('resolves the tag from .dev-tag when no tag arg is given', () => {
    writeFileSync(join(root, '.dev-tag'), 'jordan\n');
    const { status } = run(['local']);
    expect(status).toBe(0);
    expect(readActive('apps/portal/.env.local')).toContain('RISEZOME_DEV_ORIGIN=dev-jordan.risezome.app');
  });

  it('rejects an unknown mode with a non-zero exit', () => {
    const { status } = run(['nathan', 'prod']);
    expect(status).not.toBe(0);
  });

  it('errors when a persistent .env.dev is missing, leaving no active file', () => {
    rmSync(join(root, 'apps', 'portal', '.env.dev'));
    const { status } = run(['nathan', 'local']);
    expect(status).not.toBe(0);
    expect(existsSync(join(root, 'apps', 'portal', '.env.local'))).toBe(false);
  });

  it('does not print secret values to stdout', () => {
    const { stdout } = run(['nathan', 'local']);
    expect(stdout).not.toContain('sb_secret_hosted_VALUE');
    expect(stdout).not.toContain('shared-secret');
    expect(stdout).toMatch(/restart/i);
  });
});
