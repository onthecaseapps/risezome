import { describe, expect, it } from 'vitest';
import {
  launchRecallBot,
  ZdrEnforcementError,
  type LaunchBotArgs,
} from '../../app/_lib/recall-bot-launcher';

/**
 * R11b is the trust-story keystone for Risezome: every Recall.ai bot
 * we create MUST be in zero-data-retention mode. These tests are the
 * regression net.
 *
 * The launcher fails closed — even if someone deletes the `retention:
 * null` line from the body builder, the assertion runs before fetch and
 * throws. We test that explicitly.
 */

function baseArgs(): LaunchBotArgs {
  return {
    meetingUrl: 'https://us02web.zoom.us/j/1234567890?pwd=abc',
    meetingId: '11111111-1111-1111-1111-111111111111',
    orgId: '22222222-2222-2222-2222-222222222222',
    userId: '33333333-3333-3333-3333-333333333333',
    userName: 'Jordan Lee',
    botWsJwt: 'test.jwt.token',
  };
}

function makeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    return handler(req);
  }) as unknown as typeof fetch;
}

describe('launchRecallBot — happy path', () => {
  it('returns the recall bot id on 2xx', async () => {
    const fakeFetch = makeFetch(async () =>
      new Response(JSON.stringify({ id: 'recall-bot-xyz' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await launchRecallBot(baseArgs(), {
      apiKey: 'test-key',
      deepgramKey: 'dg-key',
      botWorkerBaseUrl: 'wss://bot-worker.test',
      region: 'us-east-1',
      fetch: fakeFetch,
    });
    if (!result.success) throw new Error(`expected success, got ${result.errorCode}`);
    expect(result.recallBotId).toBe('recall-bot-xyz');
  });
});

describe('launchRecallBot — R11b: ZDR enforcement (the trust keystone)', () => {
  it('sends recording_config.retention === null in the request body', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'bot-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    expect(capturedBody).not.toBeNull();
    const rec = (capturedBody as unknown as { recording_config: { retention: unknown } }).recording_config;
    expect(rec.retention).toBeNull();
  });

  it('sends transcript.provider.deepgram_streaming.mode === "prioritize_low_latency"', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    const dg = (capturedBody as unknown as {
      recording_config: { transcript: { provider: { deepgram_streaming: { mode: string } } } };
    }).recording_config.transcript.provider.deepgram_streaming;
    expect(dg.mode).toBe('prioritize_low_latency');
  });

  it('refuses to fetch if retention is mutated away from null', async () => {
    // Simulate a regression where the body builder accidentally drops
    // retention. We feed the launcher a transform hook that mutates the
    // body just before the assertion, proving the assertion runs and
    // throws before any network call.
    let fetchCalled = false;
    const fakeFetch = makeFetch(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    await expect(
      launchRecallBot(baseArgs(), {
        apiKey: 'k',
        deepgramKey: 'd',
        botWorkerBaseUrl: 'wss://b.t',
        region: 'us-east-1',
        fetch: fakeFetch,
        // Test-only escape hatch: mutate body just before send to
        // verify the assertion catches the drift.
        __mutateBodyForTest: (body) => {
          delete (body as { recording_config: { retention?: unknown } }).recording_config.retention;
        },
      }),
    ).rejects.toThrow(ZdrEnforcementError);

    expect(fetchCalled).toBe(false);
  });

  it('refuses to fetch if mode is mutated away from prioritize_low_latency', async () => {
    let fetchCalled = false;
    const fakeFetch = makeFetch(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    await expect(
      launchRecallBot(baseArgs(), {
        apiKey: 'k',
        deepgramKey: 'd',
        botWorkerBaseUrl: 'wss://b.t',
        region: 'us-east-1',
        fetch: fakeFetch,
        __mutateBodyForTest: (body) => {
          (
            body as {
              recording_config: {
                transcript: { provider: { deepgram_streaming: { mode: string } } };
              };
            }
          ).recording_config.transcript.provider.deepgram_streaming.mode = 'high_accuracy';
        },
      }),
    ).rejects.toThrow(ZdrEnforcementError);

    expect(fetchCalled).toBe(false);
  });
});

describe('launchRecallBot — request body shape', () => {
  it('includes meeting_url, bot_name "Risezome", chat message with userName, metadata', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://bot.example',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    const body = capturedBody as unknown as Record<string, unknown>;
    expect(body['meeting_url']).toBe('https://us02web.zoom.us/j/1234567890?pwd=abc');
    expect(body['bot_name']).toBe('Risezome');

    const chat = body['chat'] as { on_bot_join: { send_to: string; message: string } };
    expect(chat.on_bot_join.send_to).toBe('everyone');
    expect(chat.on_bot_join.message).toContain('Jordan Lee');
    expect(chat.on_bot_join.message).toContain('11111111-1111-1111-1111-111111111111');

    const metadata = body['metadata'] as Record<string, string>;
    expect(metadata['org_id']).toBe('22222222-2222-2222-2222-222222222222');
    expect(metadata['meeting_id']).toBe('11111111-1111-1111-1111-111111111111');
    expect(metadata['user_id']).toBe('33333333-3333-3333-3333-333333333333');

    const rt = body['recording_config'] as {
      realtime_endpoints: Array<{ type: string; url: string; events: string[] }>;
    };
    expect(rt.realtime_endpoints[0]?.type).toBe('websocket');
    expect(rt.realtime_endpoints[0]?.url).toBe(
      'wss://bot.example/recall/11111111-1111-1111-1111-111111111111/test.jwt.token',
    );
    expect(rt.realtime_endpoints[0]?.events).toContain('transcript.data');
  });

  it('includes metadata.developer_id only when developerId is set (local-dev Recall isolation)', async () => {
    const capture = async (deps: Record<string, unknown>): Promise<Record<string, string>> => {
      let captured: Record<string, unknown> | null = null;
      const fakeFetch = makeFetch(async (req) => {
        captured = (await req.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
      });
      await launchRecallBot(baseArgs(), {
        apiKey: 'k', deepgramKey: 'd', botWorkerBaseUrl: 'wss://b.t', region: 'us-east-1', fetch: fakeFetch, ...deps,
      });
      return (captured as unknown as Record<string, unknown>)['metadata'] as Record<string, string>;
    };

    const withTag = await capture({ developerId: 'nathan' });
    expect(withTag['developer_id']).toBe('nathan');

    const withoutTag = await capture({});
    expect(withoutTag['developer_id']).toBeUndefined();

    const emptyTag = await capture({ developerId: '' });
    expect(emptyTag['developer_id']).toBeUndefined();
  });

  it('hits the right region URL', async () => {
    let capturedUrl: string | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedUrl = req.url;
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-west-2',
      fetch: fakeFetch,
    });

    expect(capturedUrl).toBe('https://us-west-2.recall.ai/api/v1/bot/');
  });

  it('sends the api key in the Authorization header as "Token <key>"', async () => {
    let capturedAuth: string | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedAuth = req.headers.get('authorization');
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'my-key',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    expect(capturedAuth).toBe('Token my-key');
  });
});

describe('launchRecallBot — duration safety cap', () => {
  it('defaults max call duration to 300s when not passed', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    const auto = (capturedBody as unknown as {
      automatic_leave: {
        in_call_recording_timeout: number;
        in_call_not_recording_timeout: number;
      };
    }).automatic_leave;
    expect(auto.in_call_recording_timeout).toBe(300);
    expect(auto.in_call_not_recording_timeout).toBe(300);
  });

  it('honors a custom maxCallDurationSeconds', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = makeFetch(async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 'bot-1' }), { status: 201 });
    });

    await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      maxCallDurationSeconds: 3600,
      fetch: fakeFetch,
    });

    const auto = (capturedBody as unknown as {
      automatic_leave: {
        in_call_recording_timeout: number;
        in_call_not_recording_timeout: number;
      };
    }).automatic_leave;
    expect(auto.in_call_recording_timeout).toBe(3600);
    expect(auto.in_call_not_recording_timeout).toBe(3600);
  });

  it('rejects non-positive durations rather than silently sending an unbounded bot', async () => {
    const fakeFetch = makeFetch(async () => new Response('{}', { status: 200 }));
    await expect(
      launchRecallBot(baseArgs(), {
        apiKey: 'k',
        deepgramKey: 'd',
        botWorkerBaseUrl: 'wss://b.t',
        region: 'us-east-1',
        maxCallDurationSeconds: 0,
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/positive/i);

    await expect(
      launchRecallBot(baseArgs(), {
        apiKey: 'k',
        deepgramKey: 'd',
        botWorkerBaseUrl: 'wss://b.t',
        region: 'us-east-1',
        maxCallDurationSeconds: -1,
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/positive/i);
  });
});

describe('launchRecallBot — error paths', () => {
  it('returns errorCode=invalid_url on 4xx with body mentioning meeting_url', async () => {
    const fakeFetch = makeFetch(async () =>
      new Response(JSON.stringify({ meeting_url: ['Invalid meeting URL'] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    if (result.success) throw new Error('expected failure');
    expect(result.errorCode).toBe('invalid_url');
    expect(result.errorMessage).toContain('Invalid meeting URL');
  });

  it('returns errorCode=client_error on generic 4xx', async () => {
    const fakeFetch = makeFetch(async () =>
      new Response(JSON.stringify({ detail: 'Forbidden' }), { status: 403 }),
    );

    const result = await launchRecallBot(baseArgs(), {
      apiKey: 'k',
      deepgramKey: 'd',
      botWorkerBaseUrl: 'wss://b.t',
      region: 'us-east-1',
      fetch: fakeFetch,
    });

    if (result.success) throw new Error('expected failure');
    expect(result.errorCode).toBe('client_error');
  });

  it('throws on 5xx so Inngest retries', async () => {
    const fakeFetch = makeFetch(async () =>
      new Response('upstream error', { status: 502 }),
    );

    await expect(
      launchRecallBot(baseArgs(), {
        apiKey: 'k',
        deepgramKey: 'd',
        botWorkerBaseUrl: 'wss://b.t',
        region: 'us-east-1',
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/recall.*5\d\d/i);
  });

  it('throws on network error so Inngest retries', async () => {
    const fakeFetch = makeFetch(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(
      launchRecallBot(baseArgs(), {
        apiKey: 'k',
        deepgramKey: 'd',
        botWorkerBaseUrl: 'wss://b.t',
        region: 'us-east-1',
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/ECONNRESET/);
  });
});
