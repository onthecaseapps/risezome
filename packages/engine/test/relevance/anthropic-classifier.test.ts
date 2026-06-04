import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicRelevanceClassifier,
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_MODEL,
} from '../../src/relevance/anthropic-classifier.js';
import { RelevanceProviderError } from '../../src/relevance/contract.js';
import { buildRelevanceSystem } from '../../src/relevance/prompt.js';

function captureCalls(
  handlers: ((req: Request) => Promise<Response> | Response)[],
): { calls: Request[]; fetchImpl: typeof fetch } {
  const calls: Request[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = (async (input, init) => {
    const req = new Request(
      typeof input === 'string' || input instanceof URL ? input : input,
      init,
    );
    calls.push(req);
    const handler = handlers[i++] ?? handlers[handlers.length - 1]!;
    return handler(req);
  });
  return { calls, fetchImpl };
}

function toolUseResponse(name: string, input: Record<string, unknown>, opts?: { preambleText?: string }): Response {
  const content: { type: string; [k: string]: unknown }[] = [];
  if (opts?.preambleText !== undefined) {
    content.push({ type: 'text', text: opts.preambleText });
  }
  content.push({ type: 'tool_use', id: 'toolu_1', name, input });
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      model: 'claude-haiku-4-5',
      content,
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function textOnlyResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('AnthropicRelevanceClassifier.classify', () => {
  it('returns { decision: "surface" } for a tool_use response with decision="surface"', async () => {
    const { fetchImpl } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'surface', reason: 'substantive' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    const result = await classifier.classify('yeah so the auth thing is broken');
    expect(result).toEqual({ decision: 'surface' });
  });

  it('returns { decision: "skip", confidence, reason } for a tool_use response with decision="skip"', async () => {
    const { fetchImpl } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'skip', confidence: 0.92, reason: 'pure social filler' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    const result = await classifier.classify('how was your weekend');
    expect(result).toEqual({ decision: 'skip', confidence: 0.92, reason: 'pure social filler' });
  });

  it('scans the full content array for tool_use (not just content[0])', async () => {
    // Anthropic can emit a text preamble before tool_use under tool_choice: 'auto'.
    // Reading only content[0] would silently misclassify those as surface.
    const { fetchImpl } = captureCalls([
      () => toolUseResponse('should_surface',
        { decision: 'skip', confidence: 0.8, reason: 'acknowledgment' },
        { preambleText: 'Looking at this utterance...' }
      ),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    const result = await classifier.classify('right');
    expect(result).toEqual({ decision: 'skip', confidence: 0.8, reason: 'acknowledgment' });
  });

  it('throws bad-request when response has no tool_use block (model misbehaved)', async () => {
    const { fetchImpl } = captureCalls([() => textOnlyResponse('I think this is filler.')]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    await expect(classifier.classify('yeah')).rejects.toMatchObject({
      kind: 'bad-request',
    });
  });

  it('first tool_use wins when multiple tool_use blocks are present', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'msg_test',
          model: 'claude-haiku-4-5',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'should_surface', input: { decision: 'skip', confidence: 0.9, reason: 'first' } },
            { type: 'tool_use', id: 'toolu_2', name: 'should_surface', input: { decision: 'surface' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    const result = await classifier.classify('yeah');
    expect(result).toEqual({ decision: 'skip', confidence: 0.9, reason: 'first' });
  });

  it('retries on 429 with Retry-After and succeeds on retry', async () => {
    const onRetryWait = vi.fn();
    const { fetchImpl, calls } = captureCalls([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }),
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({
      apiKey: 'k',
      fetchImpl,
      onRetryWait,
    });
    const result = await classifier.classify('yeah');
    expect(result).toEqual({ decision: 'surface' });
    expect(calls.length).toBe(2);
    expect(onRetryWait).toHaveBeenCalledOnce();
  });

  it('throws auth-error on 401 immediately (no retry)', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => new Response('unauthorized', { status: 401 }),
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    await expect(classifier.classify('yeah')).rejects.toMatchObject({ kind: 'auth-error' });
    expect(calls.length).toBe(1);
  });

  it('retries on 500 then throws server-error when exhausted', async () => {
    const handlers = Array.from({ length: 10 }, () => () =>
      new Response('server error', { status: 500 })
    );
    const { fetchImpl, calls } = captureCalls(handlers);
    const classifier = new AnthropicRelevanceClassifier({
      apiKey: 'k',
      fetchImpl,
      maxRetries: 3,
    });
    await expect(classifier.classify('yeah')).rejects.toMatchObject({ kind: 'server-error' });
    expect(calls.length).toBe(3);
  });

  it('propagates AbortError when aborted mid-call (no retry)', async () => {
    const controller = new AbortController();
    const { fetchImpl } = captureCalls([
      () =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    const p = classifier.classify('yeah', { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports usage via onUsage callback', async () => {
    const onUsage = vi.fn();
    const { fetchImpl } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({
      apiKey: 'k',
      fetchImpl,
      onUsage,
    });
    await classifier.classify('yeah');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]![0]).toMatchObject({
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 5000,
    });
  });

  it('sends correct headers and body shape', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'test-key', fetchImpl });
    await classifier.classify('how does X work');
    const req = calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers.get('x-api-key')).toBe('test-key');
    expect(req.headers.get('anthropic-version')).toBe(ANTHROPIC_VERSION);
    const body = await req.json() as { model: string; tools: unknown[]; tool_choice: { type: string; name?: string }; messages: { content: string }[] };
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.tools).toHaveLength(1);
    // Tool choice is forced to the single relevance tool so the model can't
    // reply text-only (which the parser treats as a bad-request).
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'should_surface' });
    expect(body.messages[0]!.content).toBe('how does X work');
  });

  it('sends bare utterance when no context is supplied (cold start / daemon path)', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify('and how does it scale');
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toBe('and how does it scale');
  });

  it('prepends meeting context (current_topic + open_questions) to the user message when context is provided', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify('and where in the code base is that', {
      context: {
        current_topic: 'auth flow',
        open_questions: ['How does SSO work?'],
      },
    });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    const content = body.messages[0]!.content;
    expect(content).toContain('Meeting context so far:');
    expect(content).toContain('Current topic: auth flow');
    expect(content).toContain('How does SSO work?');
    expect(content).toContain('Utterance: and where in the code base is that');
    // Context appears BEFORE the utterance
    expect(content.indexOf('Meeting context')).toBeLessThan(content.indexOf('Utterance:'));
  });

  it('falls back to bare utterance when context is empty (no topic, no questions)', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('should_surface', { decision: 'surface' }),
    ]);
    const classifier = new AnthropicRelevanceClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify('hello', {
      context: { current_topic: '', open_questions: [] },
    });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toBe('hello');
  });
});

describe('buildRelevanceSystem', () => {
  it('returns a single system block with cache_control: ephemeral', () => {
    const blocks = buildRelevanceSystem();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('prompt is at least 4096 tokens (estimated as chars/3.5 conservatively)', () => {
    // Anthropic's Haiku cache floor is 4096 tokens. A conservative
    // chars/3.5 estimator means 4096 tokens ≈ 14336 chars. If we beat
    // that, the real tokenizer should comfortably clear the floor.
    const blocks = buildRelevanceSystem();
    const totalChars = blocks.reduce((acc, b) => acc + b.text.length, 0);
    expect(totalChars).toBeGreaterThanOrEqual(14_336);
  });

  it('prompt biases toward surface on uncertainty', () => {
    // The plan's D4 bar is "default to surface on uncertainty." The prompt
    // should explicitly say so somewhere visible.
    const text = buildRelevanceSystem()[0]!.text.toLowerCase();
    expect(text).toMatch(/when (in doubt|unsure|uncertain).*surface/);
  });

  it('prompt names the should_surface tool', () => {
    // Tool name has to match what the classifier's tools array declares.
    const text = buildRelevanceSystem()[0]!.text;
    expect(text).toMatch(/should_surface/);
  });

  it('strict mode appends the about-our-work gate; default does not (U3)', () => {
    const legacy = buildRelevanceSystem(false)[0]!.text;
    const strict = buildRelevanceSystem(true)[0]!.text;
    expect(legacy).not.toMatch(/about-our-work/i);
    expect(strict).toMatch(/about-our-work/i);
    // The strict prompt teaches the ownership discriminator + a leak example.
    expect(strict).toMatch(/reciprocal rank fusion in general/i);
    expect(strict.length).toBeGreaterThan(legacy.length);
    // Still one cached block (the addendum rides in the same ephemeral prefix).
    expect(buildRelevanceSystem(true)).toHaveLength(1);
    expect(buildRelevanceSystem(true)[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('RelevanceProviderError', () => {
  it('exposes kind and retryAfterMs', () => {
    const err = new RelevanceProviderError('rate-limit', 'rate limited', { retryAfterMs: 1000 });
    expect(err.kind).toBe('rate-limit');
    expect(err.retryAfterMs).toBe(1000);
    expect(err.code).toBe('relevance-provider');
  });
});
