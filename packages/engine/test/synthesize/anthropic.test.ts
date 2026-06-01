import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicSynthesizer,
  DEFAULT_ANTHROPIC_MODEL,
  ANTHROPIC_VERSION,
} from '../../src/synthesize/anthropic.js';
import {
  SynthesisProviderError,
  SynthesisRateLimitError,
  type SynthesisChunk,
  type SynthesisInput,
} from '../../src/synthesize/contract.js';
import { sseResponse } from '../_helpers/sse-response.js';

const SAMPLE_INPUT: SynthesisInput = {
  utterance: 'what is the status of the jira integration?',
  sources: [
    { rank: 1, title: 'Issue #1 — Jira connector', text: 'Status: planned, Phase 2.' },
  ],
};

const SUCCESS_EVENTS = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_01abcd',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 4200,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0 } },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'The Jira ' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'connector is planned [1].' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 9 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
];

async function collect(iter: AsyncIterable<SynthesisChunk>): Promise<SynthesisChunk[]> {
  const out: SynthesisChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

function captureCalls(
  handlers: ((req: Request) => Promise<Response> | Response)[],
): { calls: Request[]; fetchImpl: typeof fetch } {
  const calls: Request[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (async (input, init) => {
    const req = new Request(typeof input === 'string' || input instanceof URL ? input : input, init);
    calls.push(req);
    const handler = handlers[i++] ?? handlers[handlers.length - 1]!;
    return handler(req);
  });
  return { calls, fetchImpl };
}

describe('AnthropicSynthesizer.synthesize', () => {
  it('yields start, text deltas, and done from a successful stream', async () => {
    const { calls, fetchImpl } = captureCalls([() => sseResponse({ events: SUCCESS_EVENTS })]);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    const chunks = await collect(synth.synthesize(SAMPLE_INPUT));

    expect(chunks[0]).toMatchObject({
      type: 'start',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 12, cacheCreationTokens: 4200, cacheReadTokens: 0 },
    });
    expect(chunks.filter((c) => c.type === 'textDelta').map((c) => (c as { delta: string }).delta)).toEqual([
      'The Jira ',
      'connector is planned [1].',
    ]);
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('done');
    expect((last as { stopReason: string }).stopReason).toBe('end_turn');
    expect((last as { usage: { outputTokens: number } }).usage.outputTokens).toBe(9);

    // Verify request shape end-to-end.
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers.get('x-api-key')).toBe('sk-test');
    expect(req.headers.get('anthropic-version')).toBe(ANTHROPIC_VERSION);
    const body = (await req.json()) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.stream).toBe(true);
    expect(Array.isArray(body.system)).toBe(true);
    const systemBlocks = body.system as { type: string; cache_control?: unknown }[];
    expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
    // The LAST block must carry cache_control: ephemeral; no other block should.
    expect(systemBlocks[systemBlocks.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    for (let k = 0; k < systemBlocks.length - 1; k++) {
      expect(systemBlocks[k]!.cache_control).toBeUndefined();
    }
  });

  it('reports cache_read_input_tokens on a cache hit', async () => {
    const events = JSON.parse(JSON.stringify(SUCCESS_EVENTS)) as typeof SUCCESS_EVENTS;
    const startMessage = events[0]!.data.message as Record<string, unknown>;
    startMessage.usage = {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4200,
      output_tokens: 0,
    };
    const { fetchImpl } = captureCalls([() => sseResponse({ events })]);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    const chunks = await collect(synth.synthesize(SAMPLE_INPUT));

    const start = chunks[0] as { type: 'start'; usage: { cacheReadTokens: number; cacheCreationTokens: number } };
    expect(start.usage.cacheReadTokens).toBe(4200);
    expect(start.usage.cacheCreationTokens).toBe(0);
  });

  it('drops ping events silently', async () => {
    const events = [
      SUCCESS_EVENTS[0]!,
      { event: 'ping', data: { type: 'ping' } },
      SUCCESS_EVENTS[2]!,
      { event: 'ping', data: { type: 'ping' } },
      SUCCESS_EVENTS[5]!,
      SUCCESS_EVENTS[6]!,
    ];
    const { fetchImpl } = captureCalls([() => sseResponse({ events })]);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    const chunks = await collect(synth.synthesize(SAMPLE_INPUT));
    // No 'ping' chunk type exists; the iterator's output is the same shape as the no-ping case.
    expect(chunks.map((c) => c.type)).toEqual(['start', 'textDelta', 'done']);
  });

  it('retries on 429 honoring Retry-After', async () => {
    let attempts = 0;
    const retryWait: { waitMs: number; reason: string }[] = [];
    const handlers = [
      () => {
        attempts += 1;
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } });
      },
      () => {
        attempts += 1;
        return sseResponse({ events: SUCCESS_EVENTS });
      },
    ];
    const { fetchImpl } = captureCalls(handlers);

    // sleep happens via setTimeout — fake timers so the test doesn't actually wait 2s
    vi.useFakeTimers();
    const synth = new AnthropicSynthesizer({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 4,
      onRetryWait: (info) => retryWait.push({ waitMs: info.waitMs, reason: info.reason }),
    });

    const promise = collect(synth.synthesize(SAMPLE_INPUT));
    // First attempt happens synchronously; advance timers to flush the 2s sleep.
    await vi.advanceTimersByTimeAsync(2500);
    const chunks = await promise;
    vi.useRealTimers();

    expect(attempts).toBe(2);
    expect(retryWait).toHaveLength(1);
    expect(retryWait[0]!.reason).toBe('429 rate-limited');
    expect(retryWait[0]!.waitMs).toBeGreaterThanOrEqual(2000);
    expect(chunks.map((c) => c.type)).toEqual(['start', 'textDelta', 'textDelta', 'done']);
  });

  it('throws SynthesisRateLimitError after retries exhausted', async () => {
    const handlers = Array.from({ length: 4 }, () => () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
    );
    const { fetchImpl } = captureCalls(handlers);
    const synth = new AnthropicSynthesizer({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 4,
    });

    await expect(collect(synth.synthesize(SAMPLE_INPUT))).rejects.toMatchObject({
      constructor: SynthesisRateLimitError,
    });
  });

  it('throws SynthesisProviderError(auth-error) on 401 — no retry', async () => {
    let attempts = 0;
    const handlers = [
      () => {
        attempts += 1;
        return new Response('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}', {
          status: 401,
        });
      },
    ];
    const { fetchImpl } = captureCalls(handlers);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    await expect(collect(synth.synthesize(SAMPLE_INPUT))).rejects.toMatchObject({
      constructor: SynthesisProviderError,
      kind: 'auth-error',
    });
    expect(attempts).toBe(1);
  });

  it('throws SynthesisProviderError(bad-request) on 400 — no retry', async () => {
    let attempts = 0;
    const handlers = [
      () => {
        attempts += 1;
        return new Response('bad body', { status: 400 });
      },
    ];
    const { fetchImpl } = captureCalls(handlers);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    await expect(collect(synth.synthesize(SAMPLE_INPUT))).rejects.toMatchObject({
      constructor: SynthesisProviderError,
      kind: 'bad-request',
    });
    expect(attempts).toBe(1);
  });

  it('throws SynthesisProviderError(overloaded) on mid-stream overloaded_error', async () => {
    const events = [
      SUCCESS_EVENTS[0]!,
      SUCCESS_EVENTS[2]!,
      {
        event: 'error',
        data: { type: 'error', error: { type: 'overloaded_error', message: 'try later' } },
      },
    ];
    const { fetchImpl } = captureCalls([() => sseResponse({ events })]);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    await expect(collect(synth.synthesize(SAMPLE_INPUT))).rejects.toMatchObject({
      constructor: SynthesisProviderError,
      kind: 'overloaded',
    });
  });

  it('aborts during stream and surfaces a thrown error', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    // Hand-rolled stream: emits start + one textDelta and then sits open.
    // The test aborts after the first textDelta; the abort listener cancels
    // the stream so the iterator's reader observes done and the synthesizer
    // throws "stream ended without message_stop". The error type isn't the
    // contract here — what matters is that the iterator terminates instead
    // of hanging waiting for more events.
    const handlers = [
      (req: Request) => {
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            streamController = ctrl;
            ctrl.enqueue(
              encoder.encode(
                `event: message_start\ndata: ${JSON.stringify(SUCCESS_EVENTS[0]!.data)}\n\n`,
              ),
            );
            ctrl.enqueue(
              encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify(SUCCESS_EVENTS[2]!.data)}\n\n`,
              ),
            );
            // Intentionally leave open — no close().
          },
        });
        req.signal.addEventListener('abort', () => {
          try {
            streamController.close();
          } catch {
            // already closed
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    ];
    const { fetchImpl } = captureCalls(handlers);
    const synth = new AnthropicSynthesizer({ apiKey: 'sk-test', fetchImpl });

    const iter = synth.synthesize(SAMPLE_INPUT, controller.signal);
    const seen: SynthesisChunk[] = [];
    let thrown: unknown;
    try {
      for await (const c of iter) {
        seen.push(c);
        if (c.type === 'textDelta') controller.abort();
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.type).toBe('start');
    expect(seen[1]?.type).toBe('textDelta');
  });

  it('throws SynthesisProviderError(network-error) when fetch rejects past retries', async () => {
    let attempts = 0;
    const handlers = Array.from({ length: 4 }, () => () => {
      attempts += 1;
      return Promise.reject(new TypeError('connect ECONNREFUSED'));
    });
    const { fetchImpl } = captureCalls(handlers);
    vi.useFakeTimers();
    const synth = new AnthropicSynthesizer({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 4,
    });

    const promise = collect(synth.synthesize(SAMPLE_INPUT));
    // Attach the rejection handler BEFORE advancing timers. Otherwise the
    // rejection settles during advanceTimersByTimeAsync — before the
    // expect().rejects handler is attached — and Node reports it as an
    // unhandled rejection (the assertion still passes, but vitest flags the
    // run). Building the assertion promise here attaches the catch upfront.
    const assertion = expect(promise).rejects.toMatchObject({
      constructor: SynthesisProviderError,
      kind: 'network-error',
    });
    // Allow backoffs to elapse
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    vi.useRealTimers();
    expect(attempts).toBe(4);
  });
});
