import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  existsSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Dev-console process manager (plan U1). Spawns each managed process in its own
 * process group (`detached: true`) so stopping kills the whole group — wrappers
 * like `pnpm --filter` / `npx` fork a real child, and a plain `kill <pid>` would
 * orphan the grandchild. Merged stdout+stderr is line-split, appended to
 * .dev-logs/<name>.log, and emitted to `onLine` subscribers.
 *
 * Supabase is NOT managed here (it isn't a foreground child — see
 * supabase-control.ts); this handles portal / inngest / bot-worker / tunnel.
 */

export type ProcState = 'stopped' | 'starting' | 'running' | 'exited';

export interface ProcDef {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Start-all/stop-all ordering (ascending start, reverse stop). */
  readonly order: number;
}

export interface ProcStatus {
  readonly name: string;
  readonly state: ProcState;
  readonly pid: number | null;
  readonly exitCode: number | null;
}

const KILL_GRACE_MS = 4000;

class ManagedProcess {
  state: ProcState = 'stopped';
  pid: number | null = null;
  exitCode: number | null = null;
  #child: ChildProcess | null = null;
  #log: WriteStream | null = null;
  #buf = '';
  #stopping = false;
  readonly #logPath: string;

  constructor(
    readonly def: ProcDef,
    logDir: string,
    private readonly emit: (line: string) => void,
  ) {
    this.#logPath = join(logDir, `${def.name}.log`);
  }

  get logPath(): string {
    return this.#logPath;
  }

  start(): void {
    if (this.state === 'running' || this.state === 'starting') return;
    this.state = 'starting';
    this.exitCode = null;
    this.#stopping = false;
    this.#buf = '';
    this.#log = createWriteStream(this.#logPath, { flags: 'a' });

    let child: ChildProcess;
    try {
      child = spawn(this.def.command, [...this.def.args], {
        cwd: this.def.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      this.#line(`[console] failed to spawn: ${(err as Error).message}`);
      this.state = 'exited';
      this.exitCode = -1;
      return;
    }
    this.#child = child;
    this.pid = child.pid ?? null;

    child.on('spawn', () => {
      this.state = 'running';
      this.pid = child.pid ?? this.pid;
    });
    child.on('error', (err) => {
      this.#line(`[console] error: ${err.message}`);
      if (this.state !== 'stopped') {
        this.state = 'exited';
        this.exitCode ??= -1;
      }
    });
    const onData = (chunk: Buffer): void => this.#ingest(chunk.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      this.exitCode = code;
      this.state = this.#stopping ? 'stopped' : 'exited';
      this.#child = null;
      this.#log?.end();
      this.#log = null;
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child?.pid === undefined) {
      this.state = 'stopped';
      return;
    }
    this.#stopping = true;
    const pid = child.pid;
    return new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once('exit', done);
      // Kill the whole process group (negative pid) so wrapper grandchildren die too.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => {
        if (this.#child !== null) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }, KILL_GRACE_MS).unref();
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  tail(n: number): string[] {
    if (!existsSync(this.#logPath)) return [];
    const lines = readFileSync(this.#logPath, 'utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  }

  status(): ProcStatus {
    return { name: this.def.name, state: this.state, pid: this.pid, exitCode: this.exitCode };
  }

  #ingest(text: string): void {
    this.#buf += text;
    let idx = this.#buf.indexOf('\n');
    while (idx !== -1) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      this.#line(line);
      idx = this.#buf.indexOf('\n');
    }
  }

  #line(line: string): void {
    this.#log?.write(line + '\n');
    this.emit(line);
  }
}

export class ProcessManager extends EventEmitter {
  readonly #procs = new Map<string, ManagedProcess>();

  constructor(defs: readonly ProcDef[], logDir: string) {
    super();
    mkdirSync(logDir, { recursive: true });
    for (const def of defs) {
      this.#procs.set(def.name, new ManagedProcess(def, logDir, (line) => this.emit(`line:${def.name}`, line)));
    }
  }

  start(name: string): void {
    this.#get(name).start();
  }
  async stop(name: string): Promise<void> {
    await this.#get(name).stop();
  }
  async restart(name: string): Promise<void> {
    await this.#get(name).restart();
  }

  startAll(): void {
    for (const p of this.#ordered()) p.start();
  }
  async stopAll(): Promise<void> {
    await Promise.all(this.#ordered().reverse().map((p) => p.stop()));
  }

  status(): ProcStatus[] {
    return [...this.#procs.values()].map((p) => p.status());
  }
  tail(name: string, n: number): string[] {
    return this.#get(name).tail(n);
  }
  onLine(name: string, cb: (line: string) => void): () => void {
    const handler = (line: string): void => cb(line);
    this.on(`line:${name}`, handler);
    return () => this.off(`line:${name}`, handler);
  }
  has(name: string): boolean {
    return this.#procs.has(name);
  }
  names(): string[] {
    return this.#ordered().map((p) => p.def.name);
  }

  #ordered(): ManagedProcess[] {
    return [...this.#procs.values()].sort((a, b) => a.def.order - b.def.order);
  }
  #get(name: string): ManagedProcess {
    const p = this.#procs.get(name);
    if (p === undefined) throw new Error(`unknown process: ${name}`);
    return p;
  }
}
