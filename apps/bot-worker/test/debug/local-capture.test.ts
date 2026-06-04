import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the I/O boundaries so the controller can be exercised without a real
//    sidecar binary, Deepgram socket, or Supabase. vi.hoisted shares spies +
//    the captured Deepgram instances with the mock factories (hoisted above the
//    imports). ───────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  engines: [] as {
    handlers: Record<string, (...a: unknown[]) => void>;
    started: boolean;
    stopped: boolean;
  }[],
  runnerStart: vi.fn(() => Promise.resolve()),
  runnerStop: vi.fn(() => Promise.resolve()),
  persistAndBroadcast: vi.fn((_db: unknown, _args: unknown) => Promise.resolve({ eventId: 1, broadcasted: true })),
  maybeRetrieveAndEmit: vi.fn((_args: unknown) => Promise.resolve({ emitted: 1 })),
  recordMiss: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/debug/sidecar-runner.js', () => ({
  SidecarRunner: class {
    on(): void {}
    start = h.runnerStart;
    stop = h.runnerStop;
  },
}));

vi.mock('../../src/debug/deepgram.js', () => ({
  DeepgramTranscriptionEngine: class {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    started = false;
    stopped = false;
    constructor() {
      h.engines.push(this);
    }
    on(event: string, cb: (...a: unknown[]) => void): void {
      this.handlers[event] = cb;
    }
    start(): Promise<void> {
      this.started = true;
      return Promise.resolve();
    }
    stop(): Promise<void> {
      this.stopped = true;
      return Promise.resolve();
    }
    sendFrame(): void {}
  },
}));

// Avoid pulling in the heavy local-debug-ws module + real file/sha work.
vi.mock('../../src/debug/local-debug-ws.js', () => ({
  defaultSidecarPath: () => '/fake/sidecar',
  computeFileSha256: () => Promise.resolve('deadbeef'),
}));

vi.mock('../../src/db.js', () => ({
  persistAndBroadcast: h.persistAndBroadcast,
  // Real-shape passthrough so the asserted payload carries the utterance fields.
  utteranceToEventPayload: (u: { utteranceId: string; text: string; speaker?: string | null }) => ({
    utteranceId: u.utteranceId,
    text: u.text,
    speaker: u.speaker ?? null,
  }),
}));

vi.mock('../../src/retrieval.js', () => ({
  maybeRetrieveAndEmit: h.maybeRetrieveAndEmit,
  newRetrievalRuntime: () => ({ recentFinals: [], utteranceCountSinceLastRetrieval: 0, lastRetrievalAt: 0, liveCardByDocId: new Map() }),
}));

vi.mock('../../src/gap-capture.js', () => ({ recordMiss: h.recordMiss }));

import {
  startLocalCapture,
  stopLocalCapture,
  activeLocalCapture,
  LocalCaptureBusyError,
  __resetLocalCaptureForTest,
  type LocalCaptureDeps,
} from '../../src/debug/local-capture.js';

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function deps(over: Partial<LocalCaptureDeps> = {}): LocalCaptureDeps {
  return {
    db: {} as never,
    embedder: {} as never, // non-null → retrieval fires
    synthesizer: null,
    relevanceClassifier: null,
    classifier: null,
    skillRegistry: { size: () => 0, lookup: () => undefined } as never,
    summarizer: null,
    deepgramKey: 'dg_key',
    logger: noopLogger,
    ...over,
  };
}

function lastEngine() {
  return h.engines[h.engines.length - 1]!;
}

function emitFinal(text: string, utteranceId = 'u1'): void {
  lastEngine().handlers.final!({ utterance: { utteranceId, text, isFinal: true, startMs: 0, endMs: 1, revision: 0 } });
}

describe('local capture controller', () => {
  beforeEach(() => {
    __resetLocalCaptureForTest();
    h.engines.length = 0;
    vi.clearAllMocks();
  });

  it('start spawns the sidecar + Deepgram and marks the meeting active', async () => {
    expect(activeLocalCapture()).toBeNull();
    await startLocalCapture('m1', 'org1', deps());
    expect(activeLocalCapture()).toBe('m1');
    expect(h.runnerStart).toHaveBeenCalledTimes(1);
    expect(lastEngine().started).toBe(true);
  });

  it('a finalized utterance persists the transcript AND drives maybeRetrieveAndEmit bound to the meeting', async () => {
    await startLocalCapture('m1', 'org1', deps());
    emitFinal('how many times do we use ai');
    await Promise.resolve();
    await Promise.resolve();

    // transcript.data persisted to the meeting (the easy-to-miss bit).
    expect(h.persistAndBroadcast).toHaveBeenCalledTimes(1);
    const persistArg = h.persistAndBroadcast.mock.calls[0]![1] as { meetingId: string; orgId: string; type: string };
    expect(persistArg.meetingId).toBe('m1');
    expect(persistArg.orgId).toBe('org1');
    expect(persistArg.type).toBe('transcript.data');

    // production pipeline driven, bound to the same meeting/org.
    expect(h.maybeRetrieveAndEmit).toHaveBeenCalledTimes(1);
    const pipeArg = h.maybeRetrieveAndEmit.mock.calls[0]![0] as { meetingId: string; orgId: string; utteranceText: string };
    expect(pipeArg.meetingId).toBe('m1');
    expect(pipeArg.orgId).toBe('org1');
    expect(pipeArg.utteranceText).toBe('how many times do we use ai');
  });

  it('an empty/whitespace utterance is ignored (no persist, no retrieval)', async () => {
    await startLocalCapture('m1', 'org1', deps());
    emitFinal('   ');
    await Promise.resolve();
    expect(h.persistAndBroadcast).not.toHaveBeenCalled();
    expect(h.maybeRetrieveAndEmit).not.toHaveBeenCalled();
  });

  it('with no embedder, transcript still persists but retrieval is skipped', async () => {
    await startLocalCapture('m1', 'org1', deps({ embedder: null }));
    emitFinal('hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.persistAndBroadcast).toHaveBeenCalledTimes(1);
    expect(h.maybeRetrieveAndEmit).not.toHaveBeenCalled();
  });

  it('rejects a second start while a capture is active (one mic, KTD5)', async () => {
    await startLocalCapture('m1', 'org1', deps());
    await expect(startLocalCapture('m2', 'org1', deps())).rejects.toBeInstanceOf(LocalCaptureBusyError);
    expect(activeLocalCapture()).toBe('m1'); // first capture untouched
  });

  it('stop tears down the sidecar + engine and clears active; a later start succeeds', async () => {
    await startLocalCapture('m1', 'org1', deps());
    const eng = lastEngine();
    const stopped = await stopLocalCapture('m1', noopLogger);
    expect(stopped).toBe(true);
    expect(h.runnerStop).toHaveBeenCalledTimes(1);
    expect(eng.stopped).toBe(true);
    expect(activeLocalCapture()).toBeNull();
    // a fresh start now works
    await startLocalCapture('m3', 'org1', deps());
    expect(activeLocalCapture()).toBe('m3');
  });

  it('stop for a non-matching meeting is a no-op', async () => {
    await startLocalCapture('m1', 'org1', deps());
    expect(await stopLocalCapture('other', noopLogger)).toBe(false);
    expect(activeLocalCapture()).toBe('m1');
  });
});
