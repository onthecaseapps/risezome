import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import {
  type TranscriptionEngine,
  type TranscriptionEngineEvents,
  type Utterance,
  TranscriptionAuthError,
  TranscriptionConnectionError,
} from './contract.js';

export interface DeepgramOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly sampleRate?: number;
  readonly endpointingMs?: number;
  readonly interimResults?: boolean;
  readonly diarize?: boolean;
  readonly language?: string;
  readonly url?: string;
  readonly wsFactory?: WsFactory;
  readonly maxReconnectAttempts?: number;
  readonly preStartBufferMs?: number;
  readonly now?: () => number;
}

export type WsFactory = (
  url: string,
  protocols: string | string[],
  headers: Record<string, string>,
) => MinimalWebSocket;

export interface MinimalWebSocket {
  readyState: number;
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export const DEFAULT_DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
export const DEEPGRAM_NOVA_3 = 'nova-3';

interface DeepgramAlternative {
  readonly transcript: string;
  readonly confidence?: number;
  readonly words?: readonly {
    readonly word: string;
    readonly speaker?: number;
    readonly start: number;
    readonly end: number;
  }[];
}

interface DeepgramChannel {
  readonly alternatives: readonly DeepgramAlternative[];
}

interface DeepgramMessage {
  readonly type?: string;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly start?: number;
  readonly duration?: number;
  readonly channel?: DeepgramChannel;
}

export class DeepgramTranscriptionEngine
  extends EventEmitter<TranscriptionEngineEvents>
  implements TranscriptionEngine
{
  readonly #options: DeepgramOptions;
  readonly #factory: WsFactory;
  readonly #now: () => number;
  #ws: MinimalWebSocket | null = null;
  #ready = false;
  #stopRequested = false;
  #reconnects = 0;
  #currentUtteranceId: string | null = null;
  #currentRevision = 0;
  #lastSpeaker: string | null = null;
  // Wall-clock epoch ms captured when the Deepgram WS opens. Deepgram emits
  // `start`/`duration` in seconds-since-stream-start, but the rest of Risezome
  // (TranscriptWindow filters, the persisted store, retrieval cutoffs) treats
  // utterance times as wall-clock ms. Adding this offset at the engine
  // boundary makes startMs/endMs comparable to Date.now() everywhere.
  #connectWallclockMs: number | null = null;

  constructor(options: DeepgramOptions) {
    super();
    this.#options = options;
    this.#factory = options.wsFactory ?? defaultWsFactory;
    this.#now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.#connect();
  }

  sendFrame(samples: Int16Array): void {
    if (this.#ws === null || !this.#ready) return;
    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    try {
      this.#ws.send(buf);
    } catch (err) {
      this.emit(
        'error',
        new TranscriptionConnectionError(`send failed: ${(err as Error).message}`),
      );
    }
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    if (this.#ws === null) {
      this.emit('stopped', {});
      return;
    }
    return new Promise<void>((resolve) => {
      const ws = this.#ws;
      if (ws === null) {
        resolve();
        return;
      }
      const handleClose = (): void => {
        this.emit('stopped', {});
        resolve();
      };
      ws.on('close', handleClose);
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        ws.close(1000, 'client-stop');
      } catch {
        ws.terminate();
      }
      setTimeout(() => {
        ws.terminate();
      }, 250).unref();
    });
  }

  async #connect(): Promise<void> {
    const url = this.#buildUrl();
    const headers: Record<string, string> = {
      Authorization: `Token ${this.#options.apiKey}`,
    };
    const ws = this.#factory(url, [], headers);
    this.#ws = ws;
    this.#ready = false;

    return new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        this.#ready = true;
        this.#reconnects = 0;
        this.#connectWallclockMs = this.#now();
        resolve();
      };
      const onMessage = (...args: unknown[]): void => {
        const raw = args[0];
        if (typeof raw !== 'string' && !(raw instanceof Buffer)) return;
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        this.#handleMessage(text);
      };
      const onError = (...args: unknown[]): void => {
        const err = args[0] as Error;
        this.emit('error', new TranscriptionConnectionError(err.message));
        if (!this.#ready) reject(err);
      };
      const onClose = (...args: unknown[]): void => {
        const code = typeof args[0] === 'number' ? args[0] : 1006;
        const reason = typeof args[1] === 'string' ? args[1] : '';
        this.#ws = null;
        this.#ready = false;
        if (code === 1008 || code === 4401 || code === 4403) {
          this.emit('error', new TranscriptionAuthError(`Deepgram auth failed (${String(code)})`));
          this.emit('stopped', { reason: `auth:${String(code)}` });
          return;
        }
        if (this.#stopRequested) return;
        this.emit('disconnected', { reason: `close:${String(code)} ${reason}` });
        void this.#tryReconnect();
      };

      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
  }

  async #tryReconnect(): Promise<void> {
    const max = this.#options.maxReconnectAttempts ?? 3;
    if (this.#reconnects >= max) {
      this.emit('stopped', { reason: 'reconnect-exhausted' });
      return;
    }
    this.#reconnects += 1;
    const backoff = Math.min(1500, 200 * 2 ** (this.#reconnects - 1));
    await sleep(backoff);
    try {
      await this.#connect();
    } catch (err) {
      this.emit('error', new TranscriptionConnectionError((err as Error).message));
    }
  }

  #buildUrl(): string {
    const base = this.#options.url ?? DEFAULT_DEEPGRAM_URL;
    const url = new URL(base);
    url.searchParams.set('model', this.#options.model ?? DEEPGRAM_NOVA_3);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(this.#options.sampleRate ?? 16000));
    url.searchParams.set('channels', '1');
    url.searchParams.set('interim_results', String(this.#options.interimResults ?? true));
    if (this.#options.diarize ?? true) url.searchParams.set('diarize', 'true');
    url.searchParams.set('endpointing', String(this.#options.endpointingMs ?? 300));
    if (this.#options.language !== undefined)
      url.searchParams.set('language', this.#options.language);
    return url.toString();
  }

  #handleMessage(text: string): void {
    let parsed: DeepgramMessage;
    try {
      parsed = JSON.parse(text) as DeepgramMessage;
    } catch {
      return;
    }
    const channel = parsed.channel;
    const alt = channel?.alternatives[0];
    if (alt === undefined || alt.transcript.length === 0) return;

    const utteranceId = this.#currentUtteranceId ?? this.#newUtteranceId();
    this.#currentUtteranceId = utteranceId;

    const speaker = inferSpeaker(alt);
    const speakerKey = speaker !== undefined ? `s${String(speaker)}` : undefined;
    if (speakerKey !== undefined && speakerKey !== this.#lastSpeaker) {
      const speakerBase = this.#connectWallclockMs ?? this.#now();
      this.emit('speakerChange', { speaker: speakerKey, atMs: speakerBase + msStart(parsed) });
      this.#lastSpeaker = speakerKey;
    }

    const base = this.#connectWallclockMs ?? this.#now();
    const startMs = base + msStart(parsed);
    const endMs = base + msEnd(parsed);
    const utterance: Utterance = {
      utteranceId,
      text: alt.transcript,
      isFinal: parsed.is_final === true,
      startMs,
      endMs,
      revision: this.#currentRevision++,
      ...(speakerKey !== undefined && { speaker: speakerKey }),
      ...(alt.confidence !== undefined && { confidence: alt.confidence }),
    };

    if (parsed.is_final === true) {
      this.emit('final', { utterance });
      this.#currentUtteranceId = null;
      this.#currentRevision = 0;
    } else {
      this.emit('partial', { utterance });
    }
  }

  #newUtteranceId(): string {
    return `u_${randomBytes(6).toString('hex')}`;
  }
}

function inferSpeaker(alt: DeepgramAlternative): number | undefined {
  const words = alt.words;
  if (words === undefined || words.length === 0) return undefined;
  for (const w of words) {
    if (typeof w.speaker === 'number') return w.speaker;
  }
  return undefined;
}

function msStart(msg: DeepgramMessage): number {
  return Math.round((msg.start ?? 0) * 1000);
}

function msEnd(msg: DeepgramMessage): number {
  return msStart(msg) + Math.round((msg.duration ?? 0) * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultWsFactory: WsFactory = (url, _protocols, headers) => {
  const ws: unknown = new WebSocket(url, { headers });
  return ws as MinimalWebSocket;
};
