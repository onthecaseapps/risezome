import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsole, type ConsoleHandle } from '../../scripts/dev-console/server';
import type { ProcDef } from '../../scripts/dev-console/process-manager';

const FAKE_SB = `#!/usr/bin/env bash
case "$1" in status) exit 1 ;; *) echo "sb $*"; exit 0 ;; esac
`;
const FAKE_USEENV = `#!/usr/bin/env bash
echo "$1" > .dev-tag
`;

let handle: ConsoleHandle;
let root: string;

function setup(
  opts: { mode?: 'local' | 'hosted'; defs?: ProcDef[]; sbScript?: string } = {},
): Promise<{ base: string }> {
  root = mkdtempSync(join(tmpdir(), 'console-srv-'));
  const fakeSb = join(root, 'fake-supabase');
  writeFileSync(fakeSb, opts.sbScript ?? FAKE_SB);
  chmodSync(fakeSb, 0o755);
  const fakeUseEnv = join(root, 'fake-use-env');
  writeFileSync(fakeUseEnv, FAKE_USEENV);
  chmodSync(fakeUseEnv, 0o755);
  const defs = opts.defs ?? [
    { name: 'echoer', command: 'bash', args: ['-c', 'echo hi; sleep 5'], cwd: root, order: 2 },
  ];
  handle = createConsole({
    repoRoot: root,
    logDir: root,
    registry: defs,
    mode: opts.mode ?? 'hosted',
    supabaseCommand: fakeSb,
    useEnvCmd: { command: 'bash', scriptArgPrefix: [fakeUseEnv] },
  });
  return handle.listen(0).then((port) => ({ base: `http://127.0.0.1:${String(port)}` }));
}

afterEach(async () => {
  await handle?.close();
  rmSync(root, { recursive: true, force: true });
});

interface Item {
  name: string;
  state: string;
  pid: number | null;
}
interface StateResp {
  items: Item[];
  mode?: string;
  activity?: string | null;
}
async function getJson<T>(url: string): Promise<T> {
  return (await fetch(url)).json() as Promise<T>;
}
async function post(url: string): Promise<Response> {
  return fetch(url, { method: 'POST' });
}
async function waitFor(pred: () => Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function readSse(url: string, ms: number): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const lines: string[] = [];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const evt = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(evt);
        if (m) lines.push((JSON.parse(m[1]!) as { html: string }).html);
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(timer);
  }
  return lines;
}

describe('dev-console server', () => {
  it('starts a process via the API; /api/state reflects running', async () => {
    const { base } = await setup();
    expect((await post(`${base}/api/proc/echoer/start`)).status).toBe(200);
    await waitFor(async () => {
      const s = await getJson<StateResp>(`${base}/api/state`);
      return s.items.find((i: Item) => i.name === 'echoer')?.state === 'running';
    });
  });

  it('streams a process log over SSE, replaying the tail', async () => {
    const { base } = await setup();
    await post(`${base}/api/proc/echoer/start`);
    await waitFor(async () => {
      const s = await getJson<StateResp>(`${base}/api/state`);
      return s.items.find((i: Item) => i.name === 'echoer')?.state === 'running';
    });
    const lines = await readSse(`${base}/api/logs/echoer`, 800);
    expect(lines).toContain('hi');
  });

  it('stops a process; state → stopped', async () => {
    const { base } = await setup({
      defs: [{ name: 'sleeper', command: 'bash', args: ['-c', 'sleep 30'], cwd: '.', order: 2 }],
    });
    await post(`${base}/api/proc/sleeper/start`);
    await waitFor(
      async () =>
        (await getJson<StateResp>(`${base}/api/state`)).items.find(
          (i: Item) => i.name === 'sleeper',
        )?.state === 'running',
    );
    expect((await post(`${base}/api/proc/sleeper/stop`)).status).toBe(200);
    const s = await getJson<StateResp>(`${base}/api/state`);
    expect(s.items.find((i: Item) => i.name === 'sleeper')?.state).toBe('stopped');
  });

  it('unknown process → 404; bad route → 404; server stays up', async () => {
    const { base } = await setup();
    expect((await post(`${base}/api/proc/nope/start`)).status).toBe(404);
    expect((await fetch(`${base}/api/nonsense`)).status).toBe(404);
    expect((await getJson<StateResp>(`${base}/api/state`)).items.length).toBe(1); // still serving
  });

  it('config: POST writes the tag via use-env; GET returns it', async () => {
    const { base } = await setup();
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'jordan', mode: 'hosted' }),
    });
    expect(r.status).toBe(200);
    expect(existsSync(join(root, '.dev-tag'))).toBe(true);
    expect(readFileSync(join(root, '.dev-tag'), 'utf8').trim()).toBe('jordan');
    const cfg = await getJson<{ tag: string; mode: string }>(`${base}/api/config`);
    expect(cfg.tag).toBe('jordan');
  });

  it('config: invalid mode → 400, no write', async () => {
    const { base } = await setup();
    const r = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: 'x', mode: 'prod' }),
    });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, '.dev-tag'))).toBe(false);
  });

  it('local mode includes Supabase in state', async () => {
    const { base } = await setup({ mode: 'local' });
    const s = await getJson<StateResp>(`${base}/api/state`);
    expect(s.items.find((i: Item) => i.name === 'supabase')).toBeDefined();
    expect(s.mode).toBe('local');
  });

  it('exposes the current action via state.activity during a long start, null when idle', async () => {
    // A supabase shim whose `start` blocks, so the activity banner is observable
    // while POST /api/all/start is still in flight.
    const slowSb = `#!/usr/bin/env bash
case "$1" in
  status) exit 1 ;;
  start) sleep 1; echo "sb up"; exit 0 ;;
  *) echo "sb $*"; exit 0 ;;
esac
`;
    const { base } = await setup({ mode: 'local', sbScript: slowSb });
    expect((await getJson<StateResp>(`${base}/api/state`)).activity ?? null).toBeNull();

    const startReq = post(`${base}/api/all/start`); // do not await — it blocks on `supabase start`
    await waitFor(async () => {
      const a = (await getJson<StateResp>(`${base}/api/state`)).activity;
      return typeof a === 'string' && /supabase/i.test(a);
    });
    await startReq;
    expect((await getJson<StateResp>(`${base}/api/state`)).activity ?? null).toBeNull();
  });

  it('start-all ensures the tunnel (creates its config) before launching it', async () => {
    root = mkdtempSync(join(tmpdir(), 'console-tun-'));
    const tunnelConfig = join(root, 'risezome-dev-test.yml');
    const ensure = join(root, 'fake-ensure');
    // Stand-in for ensure-tunnel.sh: writes the config so the tunnel can start.
    writeFileSync(
      ensure,
      `#!/usr/bin/env bash\necho "[tunnel] ready"\nprintf 'x' > "${tunnelConfig}"\n`,
    );
    chmodSync(ensure, 0o755);
    const defs: ProcDef[] = [
      {
        name: 'tunnel',
        command: 'bash',
        args: ['-c', 'sleep 30'],
        cwd: root,
        order: 5,
        requiresConfigPath: tunnelConfig,
      },
    ];
    handle = createConsole({
      repoRoot: root,
      logDir: root,
      registry: defs,
      mode: 'hosted',
      tag: 'test',
      ensureTunnelCmd: { command: 'bash', scriptArgPrefix: [ensure] },
    });
    const base = `http://127.0.0.1:${String(await handle.listen(0))}`;
    expect(existsSync(tunnelConfig)).toBe(false);
    await post(`${base}/api/all/start`);
    expect(existsSync(tunnelConfig)).toBe(true); // ensure ran and created the config
    await waitFor(
      async () =>
        (await getJson<StateResp>(`${base}/api/state`)).items.find((i) => i.name === 'tunnel')
          ?.state === 'running',
    );
  });

  it('start-all leaves the tunnel stopped when ensure fails (e.g. not authenticated)', async () => {
    root = mkdtempSync(join(tmpdir(), 'console-tun-'));
    const tunnelConfig = join(root, 'risezome-dev-test.yml'); // never created
    const ensure = join(root, 'fake-ensure-fail');
    writeFileSync(ensure, `#!/usr/bin/env bash\necho "[tunnel] not authenticated" >&2\nexit 4\n`);
    chmodSync(ensure, 0o755);
    const defs: ProcDef[] = [
      {
        name: 'tunnel',
        command: 'bash',
        args: ['-c', 'sleep 30'],
        cwd: root,
        order: 5,
        requiresConfigPath: tunnelConfig,
      },
    ];
    handle = createConsole({
      repoRoot: root,
      logDir: root,
      registry: defs,
      mode: 'hosted',
      tag: 'test',
      ensureTunnelCmd: { command: 'bash', scriptArgPrefix: [ensure] },
    });
    const base = `http://127.0.0.1:${String(await handle.listen(0))}`;
    await post(`${base}/api/all/start`);
    expect(existsSync(tunnelConfig)).toBe(false); // ensure failed, no config
    const s = await getJson<StateResp>(`${base}/api/state`);
    expect(s.items.find((i) => i.name === 'tunnel')?.state).toBe('stopped'); // skipped, not started
  });
});
