import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests the pnpm-dev orchestrator's decision surface via `--dry-run` (which
 * prints the plan without starting any process). Run against a temp ROOT so the
 * real repo's .dev-tag never interferes.
 */

const REAL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'dev.sh');

let root: string;
let script: string;

function run(args: string[], env: Record<string, string> = {}): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf8',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { status: err.status ?? 1, stdout: String(err.stdout ?? '') };
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dev-orch-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  script = join(root, 'scripts', 'dev.sh');
  copyFileSync(REAL_SCRIPT, script);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('dev.sh --dry-run plan', () => {
  it('local mode plans the env step, supabase bring-up, and the 3 core processes', () => {
    const { status, stdout } = run(['nathan', 'local', '--dry-run']);
    expect(status).toBe(0);
    expect(stdout).toContain('plan: tag=nathan mode=local');
    expect(stdout).toContain('step: env');
    expect(stdout).toContain('step: supabase-up');
    expect(stdout).toContain('proc: portal');
    expect(stdout).toContain('proc: inngest');
    expect(stdout).toContain('proc: bot');
    expect(stdout).not.toContain('proc: tunnel');
  });

  it('hosted mode omits the supabase bring-up', () => {
    const { stdout } = run(['nathan', 'hosted', '--dry-run']);
    expect(stdout).toContain('mode=hosted');
    expect(stdout).not.toContain('step: supabase-up');
    expect(stdout).toContain('proc: portal');
  });

  it('--no-supabase omits the supabase bring-up even in local mode', () => {
    const { stdout } = run(['nathan', 'local', '--no-supabase', '--dry-run']);
    expect(stdout).not.toContain('step: supabase-up');
  });

  it('--tunnel adds the tunnel process', () => {
    const { stdout } = run(['nathan', 'local', '--tunnel', '--dry-run']);
    expect(stdout).toContain('proc: tunnel');
  });

  it('refuses the tunnel in hosted mode without the ack env (U13)', () => {
    const { stdout } = run(['nathan', 'hosted', '--no-supabase', '--tunnel', '--dry-run'], {
      RISEZOME_TUNNEL_HOSTED_OK: '',
    });
    expect(stdout).not.toContain('proc: tunnel');
  });

  it('allows the hosted-mode tunnel when RISEZOME_TUNNEL_HOSTED_OK=1 (U13)', () => {
    const { stdout } = run(['nathan', 'hosted', '--no-supabase', '--tunnel', '--dry-run'], {
      RISEZOME_TUNNEL_HOSTED_OK: '1',
    });
    expect(stdout).toContain('proc: tunnel');
  });

  it('resolves the tag from .dev-tag when no tag arg is given', () => {
    writeFileSync(join(root, '.dev-tag'), 'jordan\n');
    const { stdout } = run(['local', '--dry-run']);
    expect(stdout).toContain('plan: tag=jordan');
  });
});
