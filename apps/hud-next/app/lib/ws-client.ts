import type { ServerMessage } from '@risezome/hud-ui';

export interface WsClientOptions {
  readonly url: string;
  readonly token: string;
  readonly onMessage: (msg: ServerMessage) => void;
  readonly onStatus?: ((status: WsStatus) => void) | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly wsFactory?: WsFactory | undefined;
}

export type WsStatus = 'connecting' | 'open' | 'disconnected';

export type WsFactory = (url: string) => MinimalWebSocket;

export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

// Cap at 2s instead of 8s. The daemon and HUD live on the same host:
// every WS failure is "the daemon is down or restarting," which usually
// resolves in well under a second.
const DEFAULT_MAX_BACKOFF_MS = 2_000;

export class WsClient {
  readonly #options: WsClientOptions;
  readonly #factory: WsFactory;
  #ws: MinimalWebSocket | null = null;
  #attempts = 0;
  #closed = false;
  #status: WsStatus = 'disconnected';
  #pendingReconnect: ReturnType<typeof setTimeout> | null = null;
  #visibilityHandler: (() => void) | null = null;

  constructor(options: WsClientOptions) {
    this.#options = options;
    this.#factory =
      options.wsFactory ??
      ((url: string): MinimalWebSocket => {
        const native = new WebSocket(url);
        return native as unknown as MinimalWebSocket;
      });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.#visibilityHandler = (): void => {
        if (document.visibilityState !== 'visible') return;
        if (this.#closed) return;
        if (this.#status === 'open') return;
        this.#forceReconnect();
      };
      document.addEventListener('visibilitychange', this.#visibilityHandler);
    }
  }

  start(): void {
    if (this.#closed) return;
    this.#setStatus('connecting');
    const sep = this.#options.url.includes('?') ? '&' : '?';
    const url = `${this.#options.url}${sep}token=${encodeURIComponent(this.#options.token)}`;
    const ws = this.#factory(url);
    this.#ws = ws;

    ws.onopen = (): void => {
      this.#attempts = 0;
      this.#setStatus('open');
       
      console.info('[risezome.ws] open');
    };
    ws.onmessage = (ev: { data: unknown }): void => {
      if (typeof ev.data !== 'string') return;
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.#options.onMessage(parsed);
    };
    ws.onerror = (): void => {
      // Surfaced through onclose.
    };
    ws.onclose = (ev: { code: number; reason: string }): void => {
      this.#ws = null;
      this.#setStatus('disconnected');
       
      console.info(
        `[risezome.ws] close code=${String(ev.code)} reason=${ev.reason || '(none)'} attempt=${String(this.#attempts)}`,
      );
      if (!this.#closed) {
        this.#scheduleReconnect();
      }
    };
  }

  stop(): void {
    this.#closed = true;
    if (this.#pendingReconnect !== null) {
      clearTimeout(this.#pendingReconnect);
      this.#pendingReconnect = null;
    }
    if (this.#visibilityHandler !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
    if (this.#ws !== null) {
      try {
        this.#ws.close();
      } catch {
        // Tolerate sockets that are already closed.
      }
      this.#ws = null;
    }
  }

  status(): WsStatus {
    return this.#status;
  }

  send(data: string): void {
    if (this.#ws === null) return;
    try {
      this.#ws.send(data);
    } catch {
      // Tolerate transient failures; status events surface the disconnect.
    }
  }

  #setStatus(s: WsStatus): void {
    if (this.#status === s) return;
    this.#status = s;
    this.#options.onStatus?.(s);
  }

  #scheduleReconnect(): void {
    this.#attempts += 1;
    const max = this.#options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const backoff = Math.min(max, 250 * 2 ** (this.#attempts - 1));
    if (this.#pendingReconnect !== null) clearTimeout(this.#pendingReconnect);
    this.#pendingReconnect = setTimeout(() => {
      this.#pendingReconnect = null;
      if (!this.#closed) this.start();
    }, backoff);
  }

  #forceReconnect(): void {
    if (this.#pendingReconnect !== null) {
      clearTimeout(this.#pendingReconnect);
      this.#pendingReconnect = null;
    }
    if (this.#ws !== null) {
      try {
        this.#ws.close();
      } catch {
        // already closed
      }
      this.#ws = null;
    }
    this.#attempts = 0;
    this.start();
  }
}
