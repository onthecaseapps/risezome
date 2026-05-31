'use client';

import { useEffect, useRef } from 'react';
import { WsClient, type WsFactory, type WsStatus } from '../lib/ws-client';
import type { ServerMessage } from '@risezome/hud-ui';

export interface UseRisezomeSocketOptions {
  readonly url: string;
  readonly token: string;
  readonly onMessage: (msg: ServerMessage) => void;
  readonly onStatus?: ((status: WsStatus) => void) | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly wsFactory?: WsFactory | undefined;
}

/**
 * React adapter around WsClient. The client is instantiated INSIDE useEffect
 * — not in useRef or module scope — so that React 19 StrictMode's deliberate
 * double-mount cleanly tears down the first connection. The effect cleanup
 * calls wsClient.stop(), which sets #closed = true and removes the
 * `visibilitychange` listener, preventing orphaned handlers between mounts.
 *
 * Callbacks are passed through ref boxes so callers don't have to memoize
 * onMessage/onStatus to keep the connection stable.
 */
export function useRisezomeSocket(options: UseRisezomeSocketOptions): void {
  const cbRef = useRef(options);
  cbRef.current = options;

  useEffect(() => {
    if (options.url.length === 0) return;
    const client = new WsClient({
      url: options.url,
      token: options.token,
      maxBackoffMs: options.maxBackoffMs,
      wsFactory: options.wsFactory,
      onMessage: (m) => cbRef.current.onMessage(m),
      onStatus: (s) => cbRef.current.onStatus?.(s),
    });
    client.start();
    return (): void => {
      client.stop();
    };
    // Connection identity is keyed by url+token. Changing the callbacks does
    // NOT tear down the socket — the ref box forwards the latest callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.url, options.token]);
}
