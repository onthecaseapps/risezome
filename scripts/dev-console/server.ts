import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProcessManager, type ProcDef, type ProcStatus } from './process-manager';
import { SupabaseControl, type SupabaseState } from './supabase-control';
import { appRegistry } from './registry';
import { renderLine } from './ansi';

/**
 * Dev-console HTTP server (plan U2, + config route U4, + teardown/ordering U6).
 * Plain node:http on 127.0.0.1: static page, JSON control API, SSE log streams.
 * No auth (localhost only), no dependencies.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const SUPABASE = 'supabase';

export interface ConsoleOptions {
  readonly repoRoot: string;
  readonly logDir: string;
  readonly registry: readonly ProcDef[];
  /** Supabase mode: local shows Supabase as a managed item; hosted hides it. */
  readonly mode: 'local' | 'hosted';
  /** Injectable for tests. */
  readonly supabaseCommand?: string;
  readonly useEnvCmd?: { command: string; scriptArgPrefix?: string[] };
}

export interface ConsoleHandle {
  readonly server: Server;
  readonly manager: ProcessManager;
  readonly supabase: SupabaseControl;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

interface ItemStatus {
  name: string;
  state: ProcState | SupabaseState;
  pid: number | null;
  exitCode: number | null;
}
type ProcState = ProcStatus['state'];

export function createConsole(opts: ConsoleOptions): ConsoleHandle {
  const manager = new ProcessManager(opts.registry, opts.logDir);
  const supabase = new SupabaseControl({
    repoRoot: opts.repoRoot,
    logDir: opts.logDir,
    emit: (line) => manager.emit('line:supabase', line),
    portalEnvPath: join(opts.repoRoot, 'apps', 'portal', '.env.local'),
    ...(opts.supabaseCommand !== undefined ? { command: opts.supabaseCommand } : {}),
  });
  let lastMode: 'local' | 'hosted' = opts.mode;
  // Human-readable description of the long-running action the console is
  // currently performing (e.g. "Starting Supabase…"), surfaced in /api/state so
  // the UI can show a banner. null when idle.
  let activity: string | null = null;

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && (path === '/' || path === '/index.html'))
      return serveStatic('index.html', 'text/html', res);
    if (method === 'GET' && path === '/app.js')
      return serveStatic('app.js', 'text/javascript', res);
    if (method === 'GET' && path === '/styles.css')
      return serveStatic('styles.css', 'text/css', res);

    if (method === 'GET' && path === '/api/state')
      return sendJson(res, 200, { items: await states(), mode: lastMode, activity });

    if (method === 'GET' && path === '/api/config') {
      return sendJson(res, 200, { tag: readTag(opts.repoRoot), mode: lastMode });
    }
    if (method === 'POST' && path === '/api/config') {
      const body = await readBody(req);
      const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
      const mode = typeof body.mode === 'string' ? body.mode : '';
      if (mode !== 'local' && mode !== 'hosted')
        return sendJson(res, 400, { ok: false, error: 'mode must be local|hosted' });
      if (tag.length === 0) return sendJson(res, 400, { ok: false, error: 'tag required' });
      activity = `Applying environment (tag ${tag}, ${mode})…`;
      let result;
      try {
        result = await runUseEnv(opts, tag, mode);
      } finally {
        activity = null;
      }
      lastMode = mode;
      return sendJson(res, result.code === 0 ? 200 : 500, {
        ok: result.code === 0,
        tag: readTag(opts.repoRoot),
        mode,
      });
    }

    const procMatch = /^\/api\/proc\/([^/]+)\/(start|stop|restart)$/.exec(path);
    if (method === 'POST' && procMatch !== null) {
      const name = decodeURIComponent(procMatch[1]!);
      const action = procMatch[2]!;
      return controlItem(name, action, res);
    }

    const allMatch = /^\/api\/all\/(start|stop)$/.exec(path);
    if (method === 'POST' && allMatch !== null) {
      try {
        if (allMatch[1] === 'start') {
          if (lastMode === 'local') {
            activity =
              'Starting Supabase — first run pulls Docker images, this can take a few minutes…';
            await supabase.start();
          }
          activity = 'Launching portal · inngest · bot-worker…';
          manager.startAll();
        } else {
          activity = 'Stopping all processes…';
          await manager.stopAll();
          if (lastMode === 'local') {
            activity = 'Stopping Supabase containers…';
            await supabase.stop();
          }
        }
      } finally {
        activity = null;
      }
      return sendJson(res, 200, { ok: true, items: await states() });
    }

    const logMatch = /^\/api\/logs\/([^/]+)$/.exec(path);
    if (method === 'GET' && logMatch !== null)
      return streamLogs(decodeURIComponent(logMatch[1]!), req, res);

    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  async function controlItem(name: string, action: string, res: ServerResponse): Promise<void> {
    try {
      if (name === SUPABASE) {
        if (action === 'start') {
          activity = 'Starting Supabase…';
          await supabase.start();
        } else if (action === 'stop') {
          activity = 'Stopping Supabase…';
          await supabase.stop();
        } else {
          activity = 'Restarting Supabase…';
          await supabase.stop();
          await supabase.start();
        }
        return sendJson(res, 200, { ok: true, items: await states() });
      }
      if (!manager.has(name))
        return sendJson(res, 404, { ok: false, error: `unknown process: ${name}` });
      if (action === 'start') manager.start(name);
      else if (action === 'stop') {
        activity = `Stopping ${name}…`;
        await manager.stop(name);
      } else {
        activity = `Restarting ${name}…`;
        await manager.restart(name);
      }
      return sendJson(res, 200, { ok: true, items: await states() });
    } finally {
      activity = null;
    }
  }

  function streamLogs(name: string, req: IncomingMessage, res: ServerResponse): void {
    const known = name === SUPABASE || manager.has(name);
    if (!known) return sendJson(res, 404, { ok: false, error: `unknown process: ${name}` });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Open comment so the browser's EventSource fires `onopen` immediately, even
    // before the process has emitted anything.
    res.write(': open\n\n');
    res.flushHeaders?.();
    const send = (line: string): void => {
      res.write(`data: ${JSON.stringify(renderLine(line))}\n\n`);
    };
    for (const line of tail(name)) send(line);
    const onLine = (line: string): void => send(line);
    manager.on(`line:${name}`, onLine);
    // Keep the stream alive across idle gaps (a process can be quiet for minutes).
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      manager.off(`line:${name}`, onLine);
    });
  }

  function tail(name: string): string[] {
    if (name === SUPABASE) {
      const p = join(opts.logDir, 'supabase.log');
      if (!existsSync(p)) return [];
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.slice(-200);
    }
    return manager.tail(name, 200);
  }

  async function states(): Promise<ItemStatus[]> {
    await manager.reconcile();
    const procs: ItemStatus[] = manager.status();
    if (lastMode === 'local') {
      await supabase.refreshState();
      return [{ name: SUPABASE, state: supabase.state, pid: null, exitCode: null }, ...procs];
    }
    return procs;
  }

  function serveStatic(file: string, type: string, res: ServerResponse): void {
    const p = join(PUBLIC_DIR, file);
    if (!existsSync(p)) return sendJson(res, 404, { ok: false, error: `missing ${file}` });
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(p));
  }

  return {
    server,
    manager,
    supabase,
    listen: (port, host = '127.0.0.1') =>
      new Promise<number>((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        void manager.stopAll().then(() => {
          // Force-close lingering SSE connections so close() (and Ctrl-C) don't hang.
          server.closeAllConnections?.();
          server.close(() => resolve());
        });
      }),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function readTag(repoRoot: string): string {
  const p = join(repoRoot, '.dev-tag');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
}
function runUseEnv(
  opts: ConsoleOptions,
  tag: string,
  mode: string,
): Promise<{ code: number | null }> {
  const command = opts.useEnvCmd?.command ?? 'bash';
  const args = [
    ...(opts.useEnvCmd?.scriptArgPrefix ?? [join(opts.repoRoot, 'scripts', 'use-env.sh')]),
    tag,
    mode,
  ];
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.repoRoot, stdio: 'ignore' });
    child.on('error', () => resolve({ code: -1 }));
    child.on('close', (code) => resolve({ code }));
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
function isMain(): boolean {
  return process.argv[1]?.endsWith('server.ts') ?? false;
}
if (isMain()) {
  const repoRoot = join(HERE, '..', '..');
  const tag = readTag(repoRoot) || 'dev';
  const mode = (process.env.DEV_CONSOLE_MODE as 'local' | 'hosted') || 'local';
  const port = Number.parseInt(process.env.DEV_CONSOLE_PORT ?? '4317', 10);
  const handle = createConsole({
    repoRoot,
    logDir: join(repoRoot, '.dev-logs'),
    registry: appRegistry(repoRoot, tag),
    mode,
  });
  void handle.listen(port).then((p) => {
    console.warn(`[dev-console] http://127.0.0.1:${String(p)}  (tag=${tag}, mode=${mode})`);
  });
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
