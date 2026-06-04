import { describe, it, expect, vi } from 'vitest';
import { LocalMeetingControl } from '../../scripts/dev-console/local-meeting-control';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Call {
  url: string;
  body: unknown;
  authorization: string | undefined;
}

/** A fetch that records calls and returns a canned response per URL substring. */
function routedFetch(routes: [string, Response | (() => Response)][]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: u,
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      authorization: headers.authorization,
    });
    for (const [match, res] of routes) {
      if (u.includes(match)) return Promise.resolve(typeof res === 'function' ? res() : res);
    }
    return Promise.resolve(jsonRes(404, { ok: false }));
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function makeControl(
  fetchImpl: typeof fetch,
  ensureSidecar = vi.fn(() => Promise.resolve()),
): { control: LocalMeetingControl; ensureSidecar: ReturnType<typeof vi.fn> } {
  const control = new LocalMeetingControl({
    portalUrl: 'http://portal',
    botWorkerUrl: 'http://bw',
    botWorkerSecret: 'sek',
    ensureSidecar,
    fetchImpl,
    log: () => undefined,
  });
  return { control, ensureSidecar };
}

const mintOk = (): Response => jsonRes(200, { ok: true, meetingId: 'm_x', orgId: 'org_x' });

describe('LocalMeetingControl', () => {
  it('start: ensures sidecar, mints via portal, starts bot-worker capture, exposes the live URL', async () => {
    const { fetch, calls } = routedFetch([
      ['/api/dev/local-meeting', mintOk],
      ['/local-capture/start', () => jsonRes(200, { ok: true })],
    ]);
    const { control, ensureSidecar } = makeControl(fetch);

    const state = await control.start();

    expect(ensureSidecar).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      active: true,
      meetingId: 'm_x',
      orgId: 'org_x',
      liveUrl: 'http://portal/meetings/m_x/live',
    });
    // Portal mint first, then bot-worker capture (with the bearer secret).
    expect(calls[0]!.url).toContain('/api/dev/local-meeting');
    expect(calls[0]!.body).toEqual({ action: 'start' });
    expect(calls[1]!.url).toContain('/local-capture/start');
    expect(calls[1]!.body).toEqual({ meetingId: 'm_x', orgId: 'org_x' });
    expect(calls[1]!.authorization).toBe('Bearer sek');
  });

  it('rejects a second start while a meeting is active (R8)', async () => {
    const { fetch } = routedFetch([
      ['/api/dev/local-meeting', mintOk],
      ['/local-capture/start', () => jsonRes(200, { ok: true })],
    ]);
    const { control } = makeControl(fetch);
    await control.start();
    await expect(control.start()).rejects.toThrow(/already running/i);
    expect(control.state().active).toBe(true);
  });

  it('a sidecar build failure aborts before minting anything (R9)', async () => {
    const { fetch, calls } = routedFetch([['/api/dev/local-meeting', mintOk]]);
    const ensureSidecar = vi.fn(() => Promise.reject(new Error('build failed')));
    const { control } = makeControl(fetch, ensureSidecar);

    await expect(control.start()).rejects.toThrow(/build failed/);
    expect(calls).toHaveLength(0); // no portal mint, no bot-worker call
    expect(control.state().active).toBe(false);
  });

  it('a bot-worker start failure completes the minted meeting (no zombie) and stays inactive', async () => {
    const { fetch, calls } = routedFetch([
      ['/api/dev/local-meeting', mintOk],
      ['/local-capture/start', () => jsonRes(409, { ok: false, error: 'busy' })],
    ]);
    const { control } = makeControl(fetch);

    await expect(control.start()).rejects.toThrow(/bot-worker capture start failed/);
    expect(control.state().active).toBe(false);
    // A cleanup stop was sent to the portal for the minted meeting.
    const stop = calls.find((c) => c.url.includes('/api/dev/local-meeting') && (c.body as { action?: string }).action === 'stop');
    expect(stop).toBeDefined();
    expect(stop!.body).toEqual({ action: 'stop', meetingId: 'm_x', orgId: 'org_x' });
  });

  it('stop: tells the bot-worker to stop, completes the meeting via portal, clears state', async () => {
    const { fetch, calls } = routedFetch([
      ['/api/dev/local-meeting', mintOk],
      ['/local-capture/start', () => jsonRes(200, { ok: true })],
      ['/local-capture/stop', () => jsonRes(200, { ok: true })],
    ]);
    const { control } = makeControl(fetch);
    await control.start();
    calls.length = 0;

    const state = await control.stop();
    expect(state).toEqual({ active: false });
    expect(calls[0]!.url).toContain('/local-capture/stop');
    expect(calls[0]!.body).toEqual({ meetingId: 'm_x' });
    const portalStop = calls.find((c) => c.url.includes('/api/dev/local-meeting'));
    expect(portalStop!.body).toEqual({ action: 'stop', meetingId: 'm_x', orgId: 'org_x' });
  });

  it('stop when no meeting is active is a no-op', async () => {
    const { fetch, calls } = routedFetch([]);
    const { control } = makeControl(fetch);
    const state = await control.stop();
    expect(state.active).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
