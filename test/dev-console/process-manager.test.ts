import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, type ProcDef } from '../../scripts/dev-console/process-manager';

/** Poll until predicate is true or timeout; throws on timeout. */
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let logDir: string;
let pm: ProcessManager;

function def(name: string, script: string): ProcDef {
  return { name, command: 'bash', args: ['-c', script], cwd: logDir, order: 1 };
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'devconsole-'));
});
afterEach(async () => {
  await pm?.stopAll();
  rmSync(logDir, { recursive: true, force: true });
});

describe('ProcessManager', () => {
  it('starts a process: state running, output to subscriber + log file', async () => {
    pm = new ProcessManager([def('echoer', 'echo hello; sleep 5')], logDir);
    const lines: string[] = [];
    pm.onLine('echoer', (l) => lines.push(l));
    pm.start('echoer');
    await waitFor(() => lines.includes('hello'));
    expect(pm.status().find((s) => s.name === 'echoer')?.state).toBe('running');
    const logPath = join(logDir, 'echoer.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('hello');
  });

  it('stop terminates the process — state stopped, no orphan', async () => {
    pm = new ProcessManager([def('sleeper', 'sleep 30')], logDir);
    pm.start('sleeper');
    await waitFor(() => pm.status().find((s) => s.name === 'sleeper')?.state === 'running');
    const pid = pm.status().find((s) => s.name === 'sleeper')!.pid!;
    expect(alive(pid)).toBe(true);
    await pm.stop('sleeper');
    expect(pm.status().find((s) => s.name === 'sleeper')?.state).toBe('stopped');
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  it('restart yields a new pid and ends running', async () => {
    pm = new ProcessManager([def('r', 'sleep 30')], logDir);
    pm.start('r');
    await waitFor(() => pm.status().find((s) => s.name === 'r')?.state === 'running');
    const pid1 = pm.status().find((s) => s.name === 'r')!.pid!;
    await pm.restart('r');
    await waitFor(() => pm.status().find((s) => s.name === 'r')?.state === 'running');
    const pid2 = pm.status().find((s) => s.name === 'r')!.pid!;
    expect(pid2).not.toBe(pid1);
    expect(alive(pid1)).toBe(false);
  });

  it('detects a process that exits on its own with its code', async () => {
    pm = new ProcessManager([def('quitter', 'exit 3')], logDir);
    pm.start('quitter');
    await waitFor(() => pm.status().find((s) => s.name === 'quitter')?.state === 'exited');
    expect(pm.status().find((s) => s.name === 'quitter')?.exitCode).toBe(3);
  });

  it('spawn failure surfaces as exited with an error line, not a throw', async () => {
    pm = new ProcessManager(
      [{ name: 'nope', command: 'definitely-not-a-real-binary-xyz', args: [], cwd: logDir, order: 1 }],
      logDir,
    );
    const lines: string[] = [];
    pm.onLine('nope', (l) => lines.push(l));
    expect(() => pm.start('nope')).not.toThrow();
    await waitFor(() => pm.status().find((s) => s.name === 'nope')?.state === 'exited');
    expect(lines.join('\n').toLowerCase()).toMatch(/error|enoent|not.*found/);
  });

  it('start on an already-running process is a no-op (no second child)', async () => {
    pm = new ProcessManager([def('once', 'sleep 30')], logDir);
    pm.start('once');
    await waitFor(() => pm.status().find((s) => s.name === 'once')?.state === 'running');
    const pid1 = pm.status().find((s) => s.name === 'once')!.pid!;
    pm.start('once');
    await new Promise((r) => setTimeout(r, 100));
    expect(pm.status().find((s) => s.name === 'once')!.pid).toBe(pid1);
  });
});
