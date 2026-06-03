import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupabaseControl } from '../../scripts/dev-console/supabase-control';

/**
 * Fake `supabase` CLI: `status` exits with $FAKE_SB_STATUS; start/db/stop echo a
 * marker and exit 0. Lets us drive the control without Docker.
 */
const FAKE = `#!/usr/bin/env bash
case "$1" in
  status) exit \${FAKE_SB_STATUS:-1} ;;
  start) echo "Started supabase"; exit 0 ;;
  db) echo "Resetting database"; exit 0 ;;
  stop) echo "Stopped supabase"; exit 0 ;;
  *) echo "unknown $*"; exit 0 ;;
esac
`;

let dir: string;
let fakeCmd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sbctl-'));
  fakeCmd = join(dir, 'fake-supabase');
  writeFileSync(fakeCmd, FAKE);
  chmodSync(fakeCmd, 0o755);
});
afterEach(() => {
  delete process.env.FAKE_SB_STATUS;
  rmSync(dir, { recursive: true, force: true });
});

function make(lines: string[]): SupabaseControl {
  return new SupabaseControl({
    repoRoot: dir,
    logDir: dir,
    emit: (l) => lines.push(l),
    command: fakeCmd,
  });
}

describe('SupabaseControl', () => {
  it('statusIsUp maps `supabase status` exit code', async () => {
    const sb = make([]);
    process.env.FAKE_SB_STATUS = '0';
    expect(await sb.statusIsUp()).toBe(true);
    process.env.FAKE_SB_STATUS = '1';
    expect(await sb.statusIsUp()).toBe(false);
  });

  it('start when stopped runs start THEN db reset; state running; output logged', async () => {
    process.env.FAKE_SB_STATUS = '1'; // not up
    const lines: string[] = [];
    const sb = make(lines);
    await sb.start();
    expect(sb.state).toBe('running');
    const log = readFileSync(join(dir, 'supabase.log'), 'utf8');
    expect(log).toContain('Started supabase');
    expect(log).toContain('Resetting database'); // reset ran on fresh start
    expect(lines.join('\n')).toContain('Started supabase');
  });

  it('start when already up does NOT reset (no data wipe)', async () => {
    process.env.FAKE_SB_STATUS = '0'; // already up
    const lines: string[] = [];
    const sb = make(lines);
    await sb.start();
    expect(sb.state).toBe('running');
    expect(lines.join('\n')).toMatch(/already running/i);
    const log = existsSync(join(dir, 'supabase.log'))
      ? readFileSync(join(dir, 'supabase.log'), 'utf8')
      : '';
    expect(log).not.toContain('Resetting database');
  });

  it('stop runs `supabase stop` and ends stopped', async () => {
    const lines: string[] = [];
    const sb = make(lines);
    await sb.stop();
    expect(sb.state).toBe('stopped');
    expect(readFileSync(join(dir, 'supabase.log'), 'utf8')).toContain('Stopped supabase');
  });

  it('a missing supabase CLI surfaces an error line, no crash, state stays stopped', async () => {
    const lines: string[] = [];
    const sb = new SupabaseControl({
      repoRoot: dir,
      logDir: dir,
      emit: (l) => lines.push(l),
      command: join(dir, 'does-not-exist-binary'),
    });
    process.env.FAKE_SB_STATUS = '1';
    await expect(sb.start()).resolves.toBeUndefined();
    expect(sb.state).toBe('stopped');
  });
});
