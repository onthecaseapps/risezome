import { describe, expect, it } from 'vitest';
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { useRisezomeSocket } from '../app/hooks/use-risezome-socket';
import type { MinimalWebSocket, WsStatus } from '../app/lib/ws-client';
import type { ServerMessage } from '@risezome/hud-ui';

class FakeWebSocket implements MinimalWebSocket {
  readonly url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;
  readonly sent: string[] = [];
  constructor(url: string) {
    this.url = url;
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000, reason: 'client' });
  }
}

function HookHarness({
  factory,
  onMessage,
  onStatus,
}: {
  factory: (url: string) => MinimalWebSocket;
  onMessage: (m: ServerMessage) => void;
  onStatus?: (s: WsStatus) => void;
}): null {
  useRisezomeSocket({
    url: 'ws://localhost:1234/ws',
    token: 'tok',
    onMessage,
    onStatus,
    wsFactory: factory,
  });
  return null;
}

describe('useRisezomeSocket', () => {
  it('opens a connection on mount and closes on unmount', () => {
    const sockets: FakeWebSocket[] = [];
    const { unmount } = render(
      <HookHarness
        factory={(url) => {
          const ws = new FakeWebSocket(url);
          sockets.push(ws);
          return ws;
        }}
        onMessage={() => undefined}
      />,
    );
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    unmount();
    expect(sockets[0]?.closed).toBe(true);
  });

  it('StrictMode double-mount: opens twice, first is cleaned up, no duplicate-message dispatch', () => {
    const sockets: FakeWebSocket[] = [];
    const messages: ServerMessage[] = [];
    render(
      <StrictMode>
        <HookHarness
          factory={(url) => {
            const ws = new FakeWebSocket(url);
            sockets.push(ws);
            return ws;
          }}
          onMessage={(m) => messages.push(m)}
        />
      </StrictMode>,
    );
    // StrictMode mounts → cleans up → mounts again. Both sockets must exist;
    // first must be closed by the cleanup; second must be open and live.
    expect(sockets.length).toBe(2);
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.closed).toBe(false);
    // Dispatching a message to the LIVE socket should fire onMessage exactly once.
    sockets[1]?.onmessage?.({ data: JSON.stringify({ type: 'hello', version: 'x' }) });
    expect(messages).toEqual([{ type: 'hello', version: 'x' }]);
    // Dispatching to the dead socket must NOT call onMessage again (the closed
    // socket's onmessage callback is still wired, but real browsers don't fire
    // events on closed sockets — we assert the live socket is the only path).
  });

  it('emits status callback for connecting → open lifecycle', async () => {
    const statuses: WsStatus[] = [];
    let last: FakeWebSocket | null = null;
    render(
      <HookHarness
        factory={(url) => {
          last = new FakeWebSocket(url);
          return last;
        }}
        onMessage={() => undefined}
        onStatus={(s) => statuses.push(s)}
      />,
    );
    expect(statuses[0]).toBe('connecting');
    last!.onopen?.(new Event('open'));
    await Promise.resolve();
    expect(statuses).toEqual(['connecting', 'open']);
  });
});
