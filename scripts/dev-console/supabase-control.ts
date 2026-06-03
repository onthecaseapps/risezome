import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Supabase control for the dev console (plan U3). Supabase is not a foreground
 * child — `supabase start` returns once the Docker stack is up. So this drives
 * it with `supabase start | stop | status` (+ `db reset` only on a fresh start),
 * streaming command output into the `supabase` log, and reports state from
 * `supabase status`.
 *
 * The `command` is injectable so tests can drive it with a fake CLI.
 */

export type SupabaseState = 'stopped' | 'starting' | 'running' | 'stopping';

export interface SupabaseControlOptions {
  readonly repoRoot: string;
  readonly logDir: string;
  readonly emit: (line: string) => void;
  /** Path to the generated portal env, read to forward GOOGLE_OAUTH_* to `supabase start`. */
  readonly portalEnvPath?: string;
  /** CLI command; defaults to "supabase". Overridden in tests. */
  readonly command?: string;
}

export class SupabaseControl {
  state: SupabaseState = 'stopped';
  readonly #opts: SupabaseControlOptions;
  readonly #command: string;
  readonly #logPath: string;

  constructor(opts: SupabaseControlOptions) {
    this.#opts = opts;
    this.#command = opts.command ?? 'supabase';
    mkdirSync(opts.logDir, { recursive: true });
    this.#logPath = join(opts.logDir, 'supabase.log');
  }

  /** True when `supabase status` exits 0. */
  async statusIsUp(): Promise<boolean> {
    const code = await this.#run(['status'], {}, /*quiet*/ true);
    return code === 0;
  }

  async refreshState(): Promise<SupabaseState> {
    if (this.state === 'starting' || this.state === 'stopping') return this.state;
    this.state = (await this.statusIsUp()) ? 'running' : 'stopped';
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state === 'starting') return;
    const alreadyUp = await this.statusIsUp();
    if (alreadyUp) {
      this.#line('[console] local Supabase already running — leaving it (not resetting your data).');
      this.state = 'running';
      return;
    }
    this.state = 'starting';
    // config.toml wires the Google provider via env(...); forward those so local
    // Google sign-in is configured.
    const extraEnv = this.#googleEnv();
    const startCode = await this.#run(['start'], extraEnv);
    if (startCode !== 0) {
      this.#line(`[console] supabase start failed (exit ${String(startCode)}).`);
      this.state = 'stopped';
      return;
    }
    this.#line('[console] applying migrations + seed (supabase db reset)…');
    await this.#run(['db', 'reset']);
    this.state = 'running';
  }

  async stop(): Promise<void> {
    this.state = 'stopping';
    await this.#run(['stop']);
    this.state = 'stopped';
  }

  #googleEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    const path = this.#opts.portalEnvPath;
    if (path === undefined || !existsSync(path)) return out;
    const text = readFileSync(path, 'utf8');
    for (const key of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']) {
      const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
      if (m?.[1] !== undefined && m[1].length > 0) out[key] = m[1];
    }
    return out;
  }

  /** Spawn `command args`, stream output to the log + emit, resolve with exit code. */
  #run(args: string[], extraEnv: Record<string, string> = {}, quiet = false): Promise<number | null> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.#command, args, {
          cwd: this.#opts.repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...extraEnv },
        });
      } catch (err) {
        this.#line(`[console] supabase ${args.join(' ')} error: ${(err as Error).message}`);
        resolve(-1);
        return;
      }
      let buf = '';
      const onData = (chunk: Buffer): void => {
        if (quiet) return;
        buf += chunk.toString('utf8');
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          this.#line(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        if (!quiet) this.#line(`[console] supabase ${args.join(' ')} error: ${err.message}`);
        resolve(-1);
      });
      child.on('close', (code) => resolve(code));
    });
  }

  #line(line: string): void {
    try {
      appendFileSync(this.#logPath, line + '\n');
    } catch {
      /* log dir went away (e.g. teardown) — emit only */
    }
    this.#opts.emit(line);
  }
}
