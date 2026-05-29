import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  DeepgramTranscriptionEngine,
  type MinimalWebSocket,
  type WsFactory,
} from '../../src/transcribe/deepgram.js';
import {
  TranscriptionAuthError,
  type FinalTranscript,
  type PartialTranscript,
  type SpeakerChange,
} from '../../src/transcribe/contract.js';

const OPEN = 1;
const CLOSED = 3;

class FakeWebSocket extends EventEmitter implements MinimalWebSocket {
  readyState = OPEN;
  readonly url: string;
  readonly sent: Buffer[] = [];

  constructor(url: string) {
    super();
    this.url = url;
  }

  send(data: string | Buffer): void {
    if (typeof data === 'string') {
      this.sent.push(Buffer.from(data, 'utf8'));
    } else {
      this.sent.push(data);
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close', code ?? 1000, reason ?? ''));
  }

  terminate(): void {
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close', 1006, 'terminated'));
  }

  override on(
    event: 'open' | 'message' | 'error' | 'close',
    listener: (...args: unknown[]) => void,
  ): this {
    super.on(event, listener);
    return this;
  }

  pushTranscript(payload: object): void {
    this.emit('message', JSON.stringify(payload));
  }

  open(): void {
    queueMicrotask(() => this.emit('open'));
  }
}

interface Harness {
  engine: DeepgramTranscriptionEngine;
  ws: FakeWebSocket;
}

async function startHarness(
  options: Partial<{
    autoOpen: boolean;
    apiKey: string;
    factoryOverride?: WsFactory;
  }> = {},
): Promise<Harness> {
  let fakeWs: FakeWebSocket | null = null;
  const factory: WsFactory =
    options.factoryOverride ??
    ((url) => {
      const ws = new FakeWebSocket(url);
      fakeWs = ws;
      if (options.autoOpen !== false) ws.open();
      return ws;
    });
  const engine = new DeepgramTranscriptionEngine({
    apiKey: options.apiKey ?? 'test-key',
    wsFactory: factory,
    interimResults: true,
    diarize: true,
  });
  await engine.start();
  if (fakeWs === null) throw new Error('Fake WS not constructed');
  return { engine, ws: fakeWs };
}

describe('DeepgramTranscriptionEngine', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.engine.stop().catch(() => undefined);
  });

  it('emits at least one partial and one final per utterance with matching utteranceId', async () => {
    const partials: PartialTranscript[] = [];
    const finals: FinalTranscript[] = [];
    h.engine.on('partial', (p) => partials.push(p));
    h.engine.on('final', (f) => finals.push(f));

    h.ws.pushTranscript({
      is_final: false,
      start: 0,
      duration: 0.5,
      channel: { alternatives: [{ transcript: 'hello' }] },
    });
    h.ws.pushTranscript({
      is_final: true,
      start: 0,
      duration: 1.0,
      channel: { alternatives: [{ transcript: 'hello world' }] },
    });

    await Promise.resolve();
    expect(partials.length).toBeGreaterThanOrEqual(1);
    expect(finals.length).toBe(1);
    expect(partials[0]?.utterance.utteranceId).toBe(finals[0]?.utterance.utteranceId);
    expect(finals[0]?.utterance.text).toBe('hello world');
  });

  it('emits a speakerChange when the speaker label flips', async () => {
    const speakerChanges: SpeakerChange[] = [];
    h.engine.on('speakerChange', (s) => speakerChanges.push(s));

    h.ws.pushTranscript({
      is_final: true,
      start: 0,
      duration: 0.5,
      channel: {
        alternatives: [
          {
            transcript: 'alice talking',
            words: [{ word: 'alice', start: 0, end: 0.5, speaker: 0 }],
          },
        ],
      },
    });
    h.ws.pushTranscript({
      is_final: true,
      start: 0.5,
      duration: 0.5,
      channel: {
        alternatives: [
          {
            transcript: 'bob replying',
            words: [{ word: 'bob', start: 0.5, end: 1.0, speaker: 1 }],
          },
        ],
      },
    });

    await Promise.resolve();
    expect(speakerChanges.map((s) => s.speaker)).toEqual(['s0', 's1']);
  });

  it('does not emit on silent input (empty transcript)', async () => {
    const partials: PartialTranscript[] = [];
    h.engine.on('partial', (p) => partials.push(p));

    h.ws.pushTranscript({
      is_final: false,
      channel: { alternatives: [{ transcript: '' }] },
    });
    await Promise.resolve();
    expect(partials).toEqual([]);
  });

  it('emits TranscriptionAuthError on 1008/4401/4403 close and does not reconnect', async () => {
    const errors: Error[] = [];
    const stops: { reason?: string }[] = [];
    h.engine.on('error', (e) => errors.push(e));
    h.engine.on('stopped', (s) => stops.push(s));

    h.ws.emit('close', 4403, 'forbidden');
    await Promise.resolve();
    expect(errors.some((e) => e instanceof TranscriptionAuthError)).toBe(true);
    expect(stops.length).toBe(1);
  });

  it('attempts reconnect on a non-auth close (1006)', async () => {
    let constructorCalls = 0;
    let lastWs: FakeWebSocket | null = null;
    const factory: WsFactory = (url) => {
      constructorCalls += 1;
      const ws = new FakeWebSocket(url);
      lastWs = ws;
      ws.open();
      return ws;
    };
    const engine = new DeepgramTranscriptionEngine({
      apiKey: 'k',
      wsFactory: factory,
      maxReconnectAttempts: 1,
    });
    await engine.start();
    expect(constructorCalls).toBe(1);

    const disconnects: { reason: string }[] = [];
    engine.on('disconnected', (d) => disconnects.push(d));

    lastWs!.emit('close', 1006, 'network');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(disconnects.length).toBe(1);
    expect(constructorCalls).toBeGreaterThanOrEqual(2);
    await engine.stop();
  });

  it('frames are forwarded as PCM buffers to the WS', () => {
    const samples = new Int16Array([0x01, 0x02, 0x03, 0x04]);
    h.engine.sendFrame(samples);
    expect(h.ws.sent.length).toBeGreaterThan(0);
    const sentBuffer = h.ws.sent[h.ws.sent.length - 1]!;
    expect(sentBuffer.length).toBe(samples.byteLength);
  });
});
