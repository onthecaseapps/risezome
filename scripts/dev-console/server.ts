import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
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
// Pseudo-stream name for the console's own orchestration log (steps + tunnel
// setup output), rendered in the dedicated Console panel.
const CONSOLE = '__console__';

export interface ConsoleOptions {
  readonly repoRoot: string;
  readonly logDir: string;
  readonly registry: readonly ProcDef[];
  /** Supabase mode: local shows Supabase as a managed item; hosted hides it. */
  readonly mode: 'local' | 'hosted';
  /** Developer tag the console booted with — drives the per-dev cloudflared tunnel. */
  readonly tag?: string;
  /** Injectable for tests. */
  readonly supabaseCommand?: string;
  readonly useEnvCmd?: { command: string; scriptArgPrefix?: string[] };
  /** Injectable ensure-tunnel command (defaults to `bash scripts/ensure-tunnel.sh`). */
  readonly ensureTunnelCmd?: { command: string; scriptArgPrefix?: string[] };
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
  // When true, a cold Supabase start runs `db reset` (wipes + re-seeds) instead
  // of `migration up` (keeps data). Default off so stop/start preserves local data.
  let resetOnStart = false;

  // Append a line to the console's own orchestration log: emits to the CONSOLE
  // stream (the Console panel) and persists so it replays on reconnect.
  function logConsole(line: string): void {
    manager.emit(`line:${CONSOLE}`, line);
    try {
      appendFileSync(join(opts.logDir, 'console.log'), line + '\n');
    } catch {
      /* log dir went away (teardown) — emit only */
    }
  }
  // Set the current step: drives the banner (activity) and records it in the
  // Console panel. Pass null to clear the banner (no log line).
  function setStep(msg: string | null): void {
    activity = msg;
    if (msg !== null) logConsole(`▶ ${msg}`);
  }

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

    if (method === 'GET' && path === '/api/state') {
      const items = await states();
      return sendJson(res, 200, {
        items,
        mode: lastMode,
        activity,
        resetOnStart,
        links: links(items),
      });
    }

    if (method === 'POST' && path === '/api/reset-on-start') {
      const body = await readBody(req);
      resetOnStart = body.enabled === true;
      logConsole(
        `▶ Reset DB on start: ${resetOnStart ? 'ON — next cold start wipes + re-seeds' : 'OFF — keeping local data'}`,
      );
      return sendJson(res, 200, { ok: true, resetOnStart });
    }

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
      setStep(`Applying environment (tag ${tag}, ${mode})…`);
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
            setStep(
              'Starting Supabase — first run pulls Docker images, this can take a few minutes…',
            );
            await supabase.start(resetOnStart);
          }
          setStep('Setting up your cloudflared tunnel…');
          await ensureTunnel();
          setStep('Launching portal · inngest · bot-worker · tunnel…');
          manager.startAll();
        } else {
          setStep('Stopping all processes…');
          await manager.stopAll();
          if (lastMode === 'local') {
            setStep('Stopping Supabase containers…');
            await supabase.stop();
          }
        }
      } finally {
        setStep(null);
      }
      return sendJson(res, 200, { ok: true, items: await states() });
    }

    if (method === 'GET' && path === '/api/events') return streamEvents(req, res);

    const logMatch = /^\/api\/logs\/([^/]+)$/.exec(path);
    if (method === 'GET' && logMatch !== null)
      return streamLogs(decodeURIComponent(logMatch[1]!), req, res);

    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  async function controlItem(name: string, action: string, res: ServerResponse): Promise<void> {
    try {
      if (name === SUPABASE) {
        if (action === 'start') {
          setStep('Starting Supabase…');
          await supabase.start(resetOnStart);
        } else if (action === 'stop') {
          setStep('Stopping Supabase…');
          await supabase.stop();
        } else {
          setStep('Restarting Supabase…');
          await supabase.stop();
          await supabase.start(resetOnStart);
        }
        return sendJson(res, 200, { ok: true, items: await states() });
      }
      if (!manager.has(name))
        return sendJson(res, 404, { ok: false, error: `unknown process: ${name}` });
      // The tunnel needs its per-dev cloudflared config to exist before it can
      // run — create it on demand when (re)starting the tunnel.
      if (name === 'tunnel' && (action === 'start' || action === 'restart')) {
        setStep('Setting up your cloudflared tunnel…');
        await ensureTunnel();
      }
      if (action === 'start') {
        setStep(`Starting ${name}…`);
        manager.start(name);
      } else if (action === 'stop') {
        setStep(`Stopping ${name}…`);
        await manager.stop(name);
      } else {
        setStep(`Restarting ${name}…`);
        await manager.restart(name);
      }
      return sendJson(res, 200, { ok: true, items: await states() });
    } finally {
      setStep(null);
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
    if (name === SUPABASE || name === CONSOLE) {
      const p = join(opts.logDir, `${name === SUPABASE ? 'supabase' : 'console'}.log`);
      if (!existsSync(p)) return [];
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.slice(-200);
    }
    return manager.tail(name, 200);
  }

  /** All stream names the UI can show, in display order (console first). */
  function streamNames(): string[] {
    return [CONSOLE, ...(lastMode === 'local' ? [SUPABASE] : []), ...manager.names()];
  }

  /**
   * Single multiplexed event stream for the UI: one SSE connection carries
   * periodic state snapshots plus every process's log lines (tagged by name),
   * so the browser never hits its ~6-connections-per-host limit (which starved
   * the old per-pane streams + state poll during a long start-all).
   */
  async function streamEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': open\n\n');
    res.flushHeaders?.();
    const send = (obj: unknown): boolean => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // State first so the client has panes before log lines arrive, then replay
    // each stream's tail.
    const initial = await states();
    send({
      type: 'state',
      items: initial,
      mode: lastMode,
      activity,
      resetOnStart,
      links: links(initial),
    });
    for (const name of streamNames()) {
      for (const line of tail(name)) send({ type: 'log', name, ...renderLine(line) });
    }

    // Live: subscribe to every stream's line events.
    const handlers = new Map<string, (line: string) => void>();
    for (const name of [CONSOLE, SUPABASE, ...manager.names()]) {
      const h = (line: string): void => void send({ type: 'log', name, ...renderLine(line) });
      manager.on(`line:${name}`, h);
      handlers.set(name, h);
    }

    let closed = false;
    const pushState = async (): Promise<void> => {
      if (closed) return;
      const items = await states();
      send({ type: 'state', items, mode: lastMode, activity, resetOnStart, links: links(items) });
    };
    const stateTimer = setInterval(() => void pushState(), 1200);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    heartbeat.unref?.();
    stateTimer.unref?.();
    req.on('close', () => {
      closed = true;
      clearInterval(stateTimer);
      clearInterval(heartbeat);
      for (const [name, h] of handlers) manager.off(`line:${name}`, h);
    });
  }

  /**
   * Ensure the per-developer cloudflared tunnel exists (create it if missing),
   * streaming progress into the Console panel. Resolves with the script's exit
   * code; non-zero (cloudflared missing / not authenticated / failure) just means
   * the tunnel won't start this round — the actionable message is already in the
   * Console log. Skipped when no tag is set.
   */
  function ensureTunnel(): Promise<number> {
    const tag = opts.tag ?? readTag(opts.repoRoot);
    if (tag.length === 0) {
      logConsole('[tunnel] no developer tag set — apply a tag first.');
      return Promise.resolve(2);
    }
    const command = opts.ensureTunnelCmd?.command ?? 'bash';
    const args = [
      ...(opts.ensureTunnelCmd?.scriptArgPrefix ?? [
        join(opts.repoRoot, 'scripts', 'ensure-tunnel.sh'),
      ]),
      tag,
    ];
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { cwd: opts.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        logConsole(`[tunnel] ensure failed: ${err instanceof Error ? err.message : String(err)}`);
        resolve(-1);
        return;
      }
      let buf = '';
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          logConsole(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        logConsole(`[tunnel] ${err.message}`);
        resolve(-1);
      });
      child.on('close', (code) => {
        if (buf.length > 0) logConsole(buf);
        if (code !== 0)
          logConsole(`[tunnel] setup exited ${String(code)} — tunnel will not start this round.`);
        resolve(code ?? -1);
      });
    });
  }

  /** URLs for the tools currently up, for the Links panel. */
  function links(items: readonly ItemStatus[]): { label: string; url: string }[] {
    const tag = opts.tag ?? readTag(opts.repoRoot);
    const up = (name: string): boolean => items.find((i) => i.name === name)?.state === 'running';
    const out: { label: string; url: string }[] = [];
    if (up('portal')) out.push({ label: 'Portal', url: 'http://localhost:3000' });
    if (up('inngest')) out.push({ label: 'Inngest dev', url: 'http://localhost:8288' });
    if (up('bot-worker'))
      out.push({ label: 'Bot-worker health', url: 'http://localhost:8787/health' });
    if (lastMode === 'local' && up(SUPABASE)) {
      out.push({ label: 'Supabase Studio', url: 'http://localhost:54323' });
      out.push({ label: 'Supabase API', url: 'http://localhost:54321' });
    }
    if (up('tunnel') && tag.length > 0) {
      out.push({ label: 'Portal (tunnel)', url: `https://dev-${tag}.risezome.app` });
      out.push({ label: 'Bot-worker (tunnel)', url: `https://bot-worker-dev-${tag}.risezome.app` });
    }
    return out;
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
    tag,
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
