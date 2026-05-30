'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { AppStateProvider, useAppDispatch } from '../state/app-state';
import { useUpwellSocket } from '../hooks/use-upwell-socket';
import type { ServerMessage } from '../types';

interface BootstrapConfig {
  readonly wsUrl: string;
  readonly token: string;
}

declare global {
  interface Window {
    UPWELL_BOOTSTRAP?: BootstrapConfig;
  }
}

/**
 * Wraps children in `<AppStateProvider>` and wires the WS hook so server
 * messages flow into the reducer. `window.UPWELL_BOOTSTRAP` is injected by
 * the daemon's HTML response; the value is read once on mount.
 *
 * If the bootstrap config is missing (e.g., dev server with no daemon),
 * the children still render — they just won't receive WS events.
 */
export function Bootstrap({ children }: { children: ReactNode }): ReactElement {
  return (
    <AppStateProvider>
      <SocketBridge />
      {children}
    </AppStateProvider>
  );
}

function SocketBridge(): null {
  const dispatch = useAppDispatch();
  const [config, setConfig] = useState<BootstrapConfig | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.UPWELL_BOOTSTRAP !== undefined) {
      setConfig(window.UPWELL_BOOTSTRAP);
    }
  }, []);

  useUpwellSocket({
    url: config?.wsUrl ?? '',
    token: config?.token ?? '',
    onMessage: (msg: ServerMessage): void => {
      switch (msg.type) {
        case 'hello':
          return;
        case 'card':
          dispatch({ type: 'card', card: msg.card });
          return;
        case 'cardUpdated':
          dispatch({ type: 'cardUpdated', update: msg.update });
          return;
        case 'cardRetracted':
          dispatch({ type: 'cardRetracted', retracted: msg.retracted });
          return;
        case 'gap':
          dispatch({ type: 'gap', gap: msg.gap });
          return;
        case 'status':
          dispatch({ type: 'meetingStatus', mode: msg.mode === 'idle' ? 'idle' : 'live' });
          return;
        case 'meetingStarted':
          dispatch({ type: 'meetingStarted' });
          return;
        case 'meetingEnded':
          dispatch({ type: 'meetingEnded' });
          return;
        case 'synthesisStart':
          dispatch({
            type: 'synthesisStart',
            start: {
              synthesisId: msg.synthesisId,
              sourceCardIds: msg.sourceCardIds,
              traceId: msg.traceId,
            },
          });
          return;
        case 'synthesisDelta':
          dispatch({
            type: 'synthesisDelta',
            delta: { synthesisId: msg.synthesisId, delta: msg.delta },
          });
          return;
        case 'synthesisDone':
          dispatch({
            type: 'synthesisDone',
            done: {
              synthesisId: msg.synthesisId,
              stopReason: msg.stopReason,
              citations: msg.citations,
              usage: msg.usage,
              ttftMs: msg.ttftMs,
              latencyMs: msg.latencyMs,
            },
          });
          return;
        case 'synthesisError': {
          const base = { synthesisId: msg.synthesisId, code: msg.code };
          const withMessage = msg.message === undefined ? base : { ...base, message: msg.message };
          const error =
            msg.retryAfterMs === undefined
              ? withMessage
              : { ...withMessage, retryAfterMs: msg.retryAfterMs };
          dispatch({ type: 'synthesisError', error });
          return;
        }
        case 'synthesisRetracted':
          dispatch({
            type: 'synthesisRetracted',
            retracted: { synthesisId: msg.synthesisId, reason: msg.reason },
          });
          return;
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
          return;
        }
      }
    },
    onStatus: (s) => dispatch({ type: 'wsStatus', status: s }),
  });

  return null;
}
