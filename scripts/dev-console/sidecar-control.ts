import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Sidecar control for the dev console. The audio-capture sidecar is an
 * OS-specific native binary (Linux: C + PulseAudio, macOS: Swift + CoreAudio)
 * built from a per-OS Makefile under `sidecars/<os>/`. Unlike the managed
 * processes this isn't long-running — it's built once and then consumed by the
 * bot-worker / daemon at runtime — so it's modelled as an "ensure" action
 * rather than a start/stop process.
 *
 * `ensure()` is idempotent: present ⇒ just (re)export the path + sha so spawned
 * children inherit them; missing ⇒ run `make check-deps` (surfaces actionable
 * install hints when the toolchain/libs are absent) then `make`, streaming build
 * output into the console's orchestration log.
 *
 * `make` and `platform` are injectable so tests can drive it without a real
 * toolchain.
 */

export type SidecarState = 'present' | 'missing' | 'building';
export type SidecarOs = 'linux' | 'macos';

export interface SidecarStatus {
  readonly state: SidecarState;
  readonly os: SidecarOs;
  readonly path: string;
}

export interface SidecarControlOptions {
  readonly repoRoot: string;
  /** Stream build output + status lines (wired to the console panel). */
  readonly emit: (line: string) => void;
  /** Build tool; defaults to "make". Overridden in tests. */
  readonly make?: string;
  /** Platform override; defaults to process.platform. Overridden in tests. */
  readonly platform?: NodeJS.Platform;
  /**
   * Invoked with the absolute binary path + its sha256 after a successful build
   * or verify, so the path is wired up "to use it". Defaults to exporting
   * RISEZOME_SIDECAR_PATH / RISEZOME_SIDECAR_SHA into this process's env — the
   * console spawns children with `env: process.env`, so they inherit it.
   */
  readonly configure?: (path: string, sha256: string) => void;
}

export class SidecarControl {
  state: SidecarState = 'missing';
  readonly os: SidecarOs;
  readonly binPath: string;
  readonly #dir: string;
  readonly #make: string;
  readonly #emit: (line: string) => void;
  readonly #configure: (path: string, sha256: string) => void;

  constructor(opts: SidecarControlOptions) {
    const platform = opts.platform ?? process.platform;
    // darwin ⇒ macos; everything else falls back to the Linux sidecar, matching
    // the consumers' own default (bot-worker defaultSidecarPath, daemon serve).
    this.os = platform === 'darwin' ? 'macos' : 'linux';
    this.#dir = join(opts.repoRoot, 'sidecars', this.os);
    this.binPath = join(this.#dir, 'build', `risezome-sidecar-${this.os}`);
    this.#make = opts.make ?? 'make';
    this.#emit = opts.emit;
    this.#configure =
      opts.configure ??
      ((path, sha): void => {
        process.env.RISEZOME_SIDECAR_PATH = path;
        process.env.RISEZOME_SIDECAR_SHA = sha;
      });
    this.refreshState();
  }

  status(): SidecarStatus {
    this.refreshState();
    return { state: this.state, os: this.os, path: this.binPath };
  }

  /**
   * Reconcile state from disk. Never clobbers an in-flight `building` so the
   * console's periodic state poll can't flip the badge mid-build.
   */
  refreshState(): SidecarState {
    if (this.state === 'building') return this.state;
    this.state = existsSync(this.binPath) ? 'present' : 'missing';
    return this.state;
  }

  /**
   * Ensure the OS sidecar is built and its path/sha wired into the env. Returns
   * the relevant exit code (0 = ready). Already-present is a fast no-op that
   * still (re)exports the env so freshly-spawned children pick it up.
   */
  async ensure(): Promise<number> {
    if (this.state === 'building') return 0;
    if (existsSync(this.binPath)) {
      this.state = 'present';
      this.#configureFromDisk();
      this.#emit(`[sidecar] ${this.os} binary present — ${this.binPath}`);
      return 0;
    }
    this.state = 'building';
    try {
      this.#emit(`[sidecar] missing — building ${this.os} sidecar (make -C sidecars/${this.os})…`);
      const depCode = await this.#run(['check-deps']);
      if (depCode !== 0) {
        this.#emit(
          `[sidecar] dependency check failed (exit ${String(depCode)}) — install the tooling shown above, then build again.`,
        );
        return depCode;
      }
      const buildCode = await this.#run([]);
      if (buildCode !== 0 || !existsSync(this.binPath)) {
        this.#emit(`[sidecar] build failed (exit ${String(buildCode)}).`);
        return buildCode === 0 ? 1 : buildCode;
      }
      this.#configureFromDisk();
      this.#emit(`[sidecar] built + configured — ${this.binPath}`);
      return 0;
    } finally {
      // Force a disk-truth re-evaluation (refreshState would no-op on 'building').
      this.state = existsSync(this.binPath) ? 'present' : 'missing';
    }
  }

  #configureFromDisk(): void {
    const sha = createHash('sha256').update(readFileSync(this.binPath)).digest('hex');
    this.#configure(this.binPath, sha);
    this.#emit(`[sidecar] RISEZOME_SIDECAR_SHA=${sha}`);
  }

  /** Spawn `make <args>` in the sidecar dir, stream output to emit, resolve exit code. */
  #run(args: string[]): Promise<number> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.#make, args, { cwd: this.#dir, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        this.#emit(`[sidecar] make error: ${(err as Error).message}`);
        resolve(-1);
        return;
      }
      let buf = '';
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          this.#emit(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        this.#emit(`[sidecar] make error: ${err.message}`);
        resolve(-1);
      });
      child.on('close', (code) => {
        if (buf.length > 0) this.#emit(buf);
        resolve(code ?? -1);
      });
    });
  }
}
