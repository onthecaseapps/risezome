import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AudioFrame, type ControlMsg, AUDIO_FRAME_SAMPLE_COUNT } from '@risezome/shared-types';
import { SidecarRunner } from '../../../src/audio/ipc/sidecar-runner.js';
import {
  PermissionError,
  SidecarHandshakeError,
  SidecarIntegrityError,
  SidecarLaunchError,
} from '../../../src/audio/ipc/errors.js';
import { type SidecarManifest } from '../../../src/audio/ipc/manifest.js';

interface FakeSidecar {
  readonly path: string;
  readonly manifest: SidecarManifest;
}

function fakeSidecar(dir: string, name: string, body: string): FakeSidecar {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  const sha256 = createHash('sha256').update(body).digest('hex');
  return { path, manifest: { [path]: { sha256 } } };
}

// Shared helpers vendored into each fixture: encode a frame and write it.
const fixtureHelpers = `
function encodeFrame(roleTag, samples) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(samples.length * 2, 0);
  const payload = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.concat([Buffer.from([roleTag]), lenBuf, payload]);
}
function syntheticSamples(seed) {
  const out = new Int16Array(${String(AUDIO_FRAME_SAMPLE_COUNT)});
  for (let i = 0; i < out.length; i++) out[i] = ((seed + i) % 32768) - 16384;
  return out;
}
function readNonceFromStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        try {
          const cmd = JSON.parse(line);
          if (cmd.type === 'nonce') resolve(cmd.nonce);
        } catch {}
      }
    });
  });
}
`;

function happyPathBody(roles: number[], frames: number): string {
  return `#!/usr/bin/env node
${fixtureHelpers}
(async () => {
  const nonce = await readNonceFromStdin();
  process.stderr.write(JSON.stringify({ type: 'hello', sidecarVersion: '0.0.1-test', nonceEcho: nonce }) + '\\n');
  process.stderr.write(JSON.stringify({ type: 'started', device: 'fake', sampleRate: 16000 }) + '\\n');
  const roles = ${JSON.stringify(roles)};
  for (let i = 0; i < ${String(frames)}; i++) {
    const role = roles[i % roles.length];
    process.stdout.write(encodeFrame(role, syntheticSamples(i)));
  }
  process.stderr.write(JSON.stringify({ type: 'stopped' }) + '\\n');
})();
`;
}

const noEchoBody = `#!/usr/bin/env node
${fixtureHelpers}
(async () => {
  await readNonceFromStdin();
  // Never echo; spin until killed.
  setInterval(() => {}, 1000);
})();
`;

const wrongNonceBody = `#!/usr/bin/env node
${fixtureHelpers}
(async () => {
  await readNonceFromStdin();
  process.stderr.write(JSON.stringify({ type: 'hello', sidecarVersion: '0', nonceEcho: 'deadbeef' }) + '\\n');
  setInterval(() => {}, 1000);
})();
`;

const permissionDeniedBody = `#!/usr/bin/env node
${fixtureHelpers}
(async () => {
  const nonce = await readNonceFromStdin();
  process.stderr.write(JSON.stringify({ type: 'hello', sidecarVersion: '0', nonceEcho: nonce }) + '\\n');
  process.stderr.write(JSON.stringify({ type: 'permission-denied', reason: 'no Screen Recording entitlement' }) + '\\n');
  process.exit(1);
})();
`;

async function collectFrames(
  runner: SidecarRunner,
  target: number,
  timeoutMs = 2000,
): Promise<AudioFrame[]> {
  const frames: AudioFrame[] = [];
  return await new Promise<AudioFrame[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for ${String(target)} frames; got ${String(frames.length)}`),
      );
    }, timeoutMs);
    runner.on('frame', (frame) => {
      frames.push(frame);
      if (frames.length === target) {
        clearTimeout(timer);
        resolve(frames);
      }
    });
    runner.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('SidecarRunner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'risezome-runner-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('matching SHA-256 + nonce echo → frames flow', async () => {
      const fake = fakeSidecar(dir, 'happy', happyPathBody([0x00], 10));
      const runner = new SidecarRunner({ sidecarPath: fake.path, manifest: fake.manifest });
      await runner.start();
      const frames = await collectFrames(runner, 10);
      expect(frames).toHaveLength(10);
      frames.forEach((f, i) => {
        expect(f.streamRole).toEqual({ kind: 'local-system' });
        expect(f.index).toBe(i);
        expect(f.samples.length).toBe(AUDIO_FRAME_SAMPLE_COUNT);
      });
      await runner.stop();
    });

    it('two-role interleaved frames decode with correct role tags', async () => {
      const fake = fakeSidecar(dir, 'interleaved', happyPathBody([0x00, 0x01], 8));
      const runner = new SidecarRunner({ sidecarPath: fake.path, manifest: fake.manifest });
      await runner.start();
      const frames = await collectFrames(runner, 8);
      expect(frames.map((f) => f.streamRole.kind)).toEqual([
        'local-system',
        'local-mic',
        'local-system',
        'local-mic',
        'local-system',
        'local-mic',
        'local-system',
        'local-mic',
      ]);
      await runner.stop();
    });

    it('surfaces a permission-denied control message as a typed PermissionError event', async () => {
      const fake = fakeSidecar(dir, 'permission', permissionDeniedBody);
      const runner = new SidecarRunner({ sidecarPath: fake.path, manifest: fake.manifest });
      const errors: Error[] = [];
      const controlEvents: ControlMsg[] = [];
      runner.on('error', (err) => errors.push(err));
      runner.on('control', (msg) => controlEvents.push(msg));
      const stoppedPromise = new Promise<void>((resolve) =>
        runner.once('stopped', () => resolve()),
      );

      await runner.start();
      await stoppedPromise;

      expect(controlEvents.some((m) => m.type === 'permission-denied')).toBe(true);
      const permErr = errors.find((e): e is PermissionError => e instanceof PermissionError);
      expect(permErr).toBeDefined();
      expect(permErr?.reason).toMatch(/screen recording/i);
    });
  });

  describe('integrity + handshake errors', () => {
    it('mismatched SHA-256 raises SidecarIntegrityError before spawn', async () => {
      const fake = fakeSidecar(dir, 'wrong-hash', happyPathBody([0x00], 1));
      const tamperedManifest: SidecarManifest = {
        [fake.path]: { sha256: '0'.repeat(64) },
      };
      const runner = new SidecarRunner({ sidecarPath: fake.path, manifest: tamperedManifest });
      await expect(runner.start()).rejects.toBeInstanceOf(SidecarIntegrityError);
    });

    it('absent manifest entry raises SidecarIntegrityError', async () => {
      const fake = fakeSidecar(dir, 'no-manifest', happyPathBody([0x00], 1));
      const runner = new SidecarRunner({ sidecarPath: fake.path, manifest: {} });
      await expect(runner.start()).rejects.toBeInstanceOf(SidecarIntegrityError);
    });

    it('nonce not echoed within timeout → killed; SidecarHandshakeError', async () => {
      const fake = fakeSidecar(dir, 'no-echo', noEchoBody);
      const runner = new SidecarRunner({
        sidecarPath: fake.path,
        manifest: fake.manifest,
        handshakeTimeoutMs: 200,
      });
      await expect(runner.start()).rejects.toBeInstanceOf(SidecarHandshakeError);
    });

    it('wrong nonce echoed → killed; SidecarHandshakeError', async () => {
      const fake = fakeSidecar(dir, 'wrong-nonce', wrongNonceBody);
      const runner = new SidecarRunner({
        sidecarPath: fake.path,
        manifest: fake.manifest,
        handshakeTimeoutMs: 500,
      });
      await expect(runner.start()).rejects.toBeInstanceOf(SidecarHandshakeError);
    });
  });

  describe('spawn errors', () => {
    it('sidecar binary not found → SidecarLaunchError', async () => {
      const runner = new SidecarRunner({
        sidecarPath: join(dir, 'does-not-exist'),
        manifest: {},
      });
      await expect(runner.start()).rejects.toBeInstanceOf(SidecarLaunchError);
    });

    it('rejects relative path', async () => {
      const runner = new SidecarRunner({
        sidecarPath: 'not-absolute',
        manifest: {},
      });
      await expect(runner.start()).rejects.toBeInstanceOf(SidecarLaunchError);
    });
  });
});
