import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarControl } from '../../scripts/dev-console/sidecar-control';

/**
 * Fake `make`: `check-deps` exits $FAKE_DEPS; the default (no-arg) target
 * "compiles" by writing the linux binary unless $FAKE_BUILD is non-zero. Lets us
 * drive the control without gcc/swiftc or PulseAudio.
 */
const FAKE_MAKE = `#!/usr/bin/env bash
case "$1" in
  check-deps) echo "deps checked"; exit \${FAKE_DEPS:-0} ;;
  "") echo "compiling sidecar";
      if [ "\${FAKE_BUILD:-0}" = "0" ]; then mkdir -p build && printf 'fake-binary' > build/risezome-sidecar-linux; fi
      exit \${FAKE_BUILD:-0} ;;
  *) echo "unknown $*"; exit 0 ;;
esac
`;

let root: string;
let sidecarDir: string;
let binPath: string;
let fakeMake: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sidecarctl-'));
  sidecarDir = join(root, 'sidecars', 'linux');
  mkdirSync(sidecarDir, { recursive: true });
  binPath = join(sidecarDir, 'build', 'risezome-sidecar-linux');
  fakeMake = join(root, 'fake-make');
  writeFileSync(fakeMake, FAKE_MAKE);
  chmodSync(fakeMake, 0o755);
});
afterEach(() => {
  delete process.env.FAKE_DEPS;
  delete process.env.FAKE_BUILD;
  delete process.env.RISEZOME_SIDECAR_PATH;
  delete process.env.RISEZOME_SIDECAR_SHA;
  rmSync(root, { recursive: true, force: true });
});

interface Configured {
  path: string;
  sha: string;
}

function make(lines: string[], configured: Configured[]): SidecarControl {
  return new SidecarControl({
    repoRoot: root,
    make: fakeMake,
    platform: 'linux',
    emit: (l) => lines.push(l),
    configure: (path, sha) => configured.push({ path, sha }),
  });
}

describe('SidecarControl', () => {
  it('resolves the OS-specific binary path', () => {
    const linux = make([], []);
    expect(linux.os).toBe('linux');
    expect(linux.binPath).toBe(binPath);

    const mac = new SidecarControl({ repoRoot: root, platform: 'darwin', emit: () => {} });
    expect(mac.os).toBe('macos');
    expect(mac.binPath).toBe(join(root, 'sidecars', 'macos', 'build', 'risezome-sidecar-macos'));
  });

  it('starts "missing" when the binary is absent', () => {
    expect(make([], []).state).toBe('missing');
  });

  it('ensure() builds when missing, then marks present + configures path/sha', async () => {
    const lines: string[] = [];
    const configured: Configured[] = [];
    const sc = make(lines, configured);

    const code = await sc.ensure();

    expect(code).toBe(0);
    expect(sc.state).toBe('present');
    expect(existsSync(binPath)).toBe(true);
    expect(lines.join('\n')).toContain('compiling sidecar');
    // Path + sha256 of the freshly built binary were handed to configure().
    const expectedSha = createHash('sha256').update(readFileSync(binPath)).digest('hex');
    expect(configured).toEqual([{ path: binPath, sha: expectedSha }]);
  });

  it('ensure() when already present is a fast no-op that still re-configures', async () => {
    mkdirSync(join(sidecarDir, 'build'), { recursive: true });
    writeFileSync(binPath, 'already-here');
    const lines: string[] = [];
    const configured: Configured[] = [];
    const sc = make(lines, configured);
    expect(sc.state).toBe('present');

    const code = await sc.ensure();

    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/binary present/i);
    expect(lines.join('\n')).not.toContain('compiling sidecar'); // no rebuild
    expect(configured).toHaveLength(1);
  });

  it('ensure() stops on a failed dependency check — no build, stays missing', async () => {
    process.env.FAKE_DEPS = '1';
    const lines: string[] = [];
    const configured: Configured[] = [];
    const sc = make(lines, configured);

    const code = await sc.ensure();

    expect(code).not.toBe(0);
    expect(sc.state).toBe('missing');
    expect(existsSync(binPath)).toBe(false);
    expect(configured).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/dependency check failed/i);
  });

  it('ensure() surfaces a build failure and stays missing', async () => {
    process.env.FAKE_BUILD = '1';
    const lines: string[] = [];
    const configured: Configured[] = [];
    const sc = make(lines, configured);

    const code = await sc.ensure();

    expect(code).not.toBe(0);
    expect(sc.state).toBe('missing');
    expect(configured).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/build failed/i);
  });

  it('default configure exports RISEZOME_SIDECAR_PATH/SHA into the env', async () => {
    const sc = new SidecarControl({ repoRoot: root, make: fakeMake, platform: 'linux', emit: () => {} });
    await sc.ensure();
    expect(process.env.RISEZOME_SIDECAR_PATH).toBe(binPath);
    expect(process.env.RISEZOME_SIDECAR_SHA).toMatch(/^[0-9a-f]{64}$/);
  });
});
