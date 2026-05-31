import { describe, expect, it } from 'vitest';
import { WsClient, type MinimalWebSocket, type WsStatus } from '../app/lib/ws-client';
import type { ServerMessage } from '@risezome/hud-ui';

class FakeWebSocket implements MinimalWebSocket {
  readonly url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({ code: 1000, reason: 'client-close' });
  }
}

describe('WsClient', () => {
  it('sends ?token= in the URL', () => {
    const sockets: FakeWebSocket[] = [];
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'abc123',
      onMessage: () => undefined,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });
    client.start();
    expect(sockets[0]?.url).toBe('ws://localhost:1234/ws?token=abc123');
  });

  it('appends &token= when the URL already has query parameters', () => {
    const sockets: FakeWebSocket[] = [];
    const client = new WsClient({
      url: 'ws://localhost:1234/ws?meeting=m1',
      token: 'abc123',
      onMessage: () => undefined,
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });
    client.start();
    expect(sockets[0]?.url).toBe('ws://localhost:1234/ws?meeting=m1&token=abc123');
  });

  it('emits status: connecting → open on a successful open', () => {
    const statuses: WsStatus[] = [];
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'k',
      onMessage: () => undefined,
      onStatus: (s) => statuses.push(s),
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        queueMicrotask(() => ws.onopen?.(new Event('open')));
        return ws;
      },
    });
    client.start();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(statuses).toEqual(['connecting', 'open']);
        resolve();
      }, 10);
    });
  });

  it('parses JSON server messages and forwards them to onMessage', () => {
    let lastMsg: ServerMessage | null = null;
    let openedWs: FakeWebSocket | null = null;
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'k',
      onMessage: (m) => (lastMsg = m),
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        openedWs = ws;
        return ws;
      },
    });
    client.start();
    openedWs!.onmessage?.({
      data: JSON.stringify({ type: 'hello', version: '0.0.0-test' } satisfies ServerMessage),
    });
    expect(lastMsg).toEqual({ type: 'hello', version: '0.0.0-test' });
  });

  it('ignores non-string and malformed messages', () => {
    let called = 0;
    let openedWs: FakeWebSocket | null = null;
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'k',
      onMessage: () => (called += 1),
      wsFactory: (url) => {
        const ws = new FakeWebSocket(url);
        openedWs = ws;
        return ws;
      },
    });
    client.start();
    openedWs!.onmessage?.({ data: 12345 });
    openedWs!.onmessage?.({ data: '{not json' });
    expect(called).toBe(0);
  });

  it('schedules a reconnect after onclose', async () => {
    let factoryCalls = 0;
    let lastWs: FakeWebSocket | null = null;
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'k',
      onMessage: () => undefined,
      maxBackoffMs: 50,
      wsFactory: (url) => {
        factoryCalls += 1;
        const ws = new FakeWebSocket(url);
        lastWs = ws;
        return ws;
      },
    });
    client.start();
    expect(factoryCalls).toBe(1);
    lastWs!.onclose?.({ code: 1006, reason: 'network' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(factoryCalls).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it('forces an immediate reconnect when document becomes visible', async () => {
    if (typeof document === 'undefined') return;
    let factoryCalls = 0;
    let lastWs: FakeWebSocket | null = null;
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'k',
      onMessage: () => undefined,
      maxBackoffMs: 10_000,
      wsFactory: (url) => {
        factoryCalls += 1;
        const ws = new FakeWebSocket(url);
        lastWs = ws;
        return ws;
      },
    });
    client.start();
    expect(factoryCalls).toBe(1);
    lastWs!.onclose?.({ code: 1006, reason: 'network' });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(factoryCalls).toBe(2);
    client.stop();
  });

  it('stop() prevents reconnect', async () => {
    let factoryCalls = 0;
    let lastWs: FakeWebSocket | null = null;
    const client = new WsClient({
      url: 'ws://localhost:1234/ws',
      token: 'k',
      onMessage: () => undefined,
      maxBackoffMs: 50,
      wsFactory: (url) => {
        factoryCalls += 1;
        const ws = new FakeWebSocket(url);
        lastWs = ws;
        return ws;
      },
    });
    client.start();
    client.stop();
    lastWs!.onclose?.({ code: 1006, reason: 'network' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(factoryCalls).toBe(1);
  });
});
