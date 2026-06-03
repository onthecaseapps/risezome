import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests scripts/ensure-tunnel.sh against a fake `cloudflared` CLI. The fake is
 * stateful via a marker file in CF_DIR: `tunnel list` reports the tunnel only
 * after `tunnel create` has run, so we can assert the create-if-missing path and
 * idempotency without touching a real Cloudflare account.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ensure-tunnel.sh');

const FAKE_CLOUDFLARED = `#!/usr/bin/env bash
# Stateful fake cloudflared. State lives in $CF_DIR/.created.
if [ "$1" = "tunnel" ]; then
  shift
  case "$1" in
    list)
      if [ -f "$CF_DIR/.created" ]; then
        echo '[{"name":"risezome-dev-test","id":"UUID-123"}]'
      else
        echo '[]'
      fi
      ;;
    create)
      touch "$CF_DIR/.created"
      : > "$CF_DIR/UUID-123.json"
      echo "Created tunnel $2 with id UUID-123"
      ;;
    route)
      echo "routed: $*"
      ;;
    *) echo "fake: unknown tunnel subcommand $1" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "fake: unknown command $*" >&2
exit 1
`;

let cfDir: string;
let fakeBin: string;

function run(tag: string, env: Record<string, string> = {}): { status: number; out: string } {
  const res = spawnSync('bash', [SCRIPT, tag], {
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARED_BIN: fakeBin, CF_DIR: cfDir, ...env },
  });
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

beforeEach(() => {
  cfDir = mkdtempSync(join(tmpdir(), 'cf-'));
  fakeBin = join(cfDir, 'fake-cloudflared');
  writeFileSync(fakeBin, FAKE_CLOUDFLARED);
  chmodSync(fakeBin, 0o755);
});
afterEach(() => {
  rmSync(cfDir, { recursive: true, force: true });
});

describe('ensure-tunnel.sh', () => {
  it('creates the tunnel and writes a config with both hostnames + WS settings', () => {
    writeFileSync(join(cfDir, 'cert.pem'), 'authed'); // authenticated
    const { status, out } = run('test');
    expect(status).toBe(0);
    expect(out).toMatch(/creating persistent tunnel risezome-dev-test/);

    const config = readFileSync(join(cfDir, 'risezome-dev-test.yml'), 'utf8');
    expect(config).toContain('tunnel: UUID-123');
    expect(config).toContain('credentials-file: ' + join(cfDir, 'UUID-123.json'));
    expect(config).toContain('hostname: dev-test.risezome.app');
    expect(config).toContain('service: http://localhost:3000');
    expect(config).toContain('hostname: bot-worker-dev-test.risezome.app');
    expect(config).toContain('service: http://localhost:8787');
    expect(config).toContain('disableChunkedEncoding: true');
  });

  it('is idempotent: a second run reuses the existing tunnel (no re-create)', () => {
    writeFileSync(join(cfDir, 'cert.pem'), 'authed');
    expect(run('test').status).toBe(0);
    const second = run('test');
    expect(second.status).toBe(0);
    expect(second.out).not.toMatch(/creating persistent tunnel/); // already exists
    expect(existsSync(join(cfDir, 'risezome-dev-test.yml'))).toBe(true);
  });

  it('exits 4 (and tells the user to log in) when not authenticated', () => {
    const { status, out } = run('test'); // no cert.pem
    expect(status).toBe(4);
    expect(out).toMatch(/not authenticated/);
    expect(out).toMatch(/cloudflared tunnel login/);
    expect(existsSync(join(cfDir, 'risezome-dev-test.yml'))).toBe(false);
  });

  it('exits 3 when cloudflared is not installed', () => {
    writeFileSync(join(cfDir, 'cert.pem'), 'authed');
    const { status, out } = run('test', { CLOUDFLARED_BIN: 'definitely-not-cloudflared-xyz' });
    expect(status).toBe(3);
    expect(out).toMatch(/not installed/);
  });

  it('exits 2 with a usage message when no tag is given', () => {
    const res = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, CLOUDFLARED_BIN: fakeBin, CF_DIR: cfDir },
    });
    expect(res.status).toBe(2);
    expect(`${res.stdout}${res.stderr}`).toMatch(/usage/);
  });
});
