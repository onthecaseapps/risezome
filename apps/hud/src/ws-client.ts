import type { ServerMessage } from './types.js';

export interface WsClientOptions {
  readonly url: string;
  readonly token: string;
  readonly onMessage: (msg: ServerMessage) => void;
  readonly onStatus?: (status: WsStatus) => void;
  readonly maxBackoffMs?: number;
  readonly wsFactory?: WsFactory;
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

const DEFAULT_MAX_BACKOFF_MS = 8_000;

export class WsClient {
  readonly #options: WsClientOptions;
  readonly #factory: WsFactory;
  #ws: MinimalWebSocket | null = null;
  #attempts = 0;
  #closed = false;
  #status: WsStatus = 'disconnected';

  constructor(options: WsClientOptions) {
    this.#options = options;
    this.#factory =
      options.wsFactory ??
      ((url: string): MinimalWebSocket => {
        const native = new WebSocket(url);
        return native as unknown as MinimalWebSocket;
      });
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
      // Surfaced through onclose; no separate handling needed here.
    };
    ws.onclose = (): void => {
      this.#ws = null;
      this.#setStatus('disconnected');
      if (!this.#closed) {
        this.#scheduleReconnect();
      }
    };
  }

  stop(): void {
    this.#closed = true;
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
    setTimeout(() => {
      if (!this.#closed) this.start();
    }, backoff);
  }
}
