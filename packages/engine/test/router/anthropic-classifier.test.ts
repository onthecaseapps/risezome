import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicClassifier,
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_MODEL,
} from '../../src/router/anthropic-classifier.js';
import {
  ClassifierProviderError,
  type ClassifierResult,
} from '../../src/router/contract.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import type { Skill } from '../../src/skills/contract.js';

function makeSkill(name: string): Skill {
  return {
    source: 'github',
    name,
    description: `description of ${name}`,
    inputSchema: {
      type: 'object',
      properties: { state: { type: 'string' } },
    },
    handler: () => Promise.resolve({ kind: 'count', summary: 'ok' }),
  };
}

function makeRegistry(): SkillRegistry {
  const r = new SkillRegistry();
  r.register(makeSkill('github_count'));
  r.register(makeSkill('github_list'));
  r.register(makeSkill('github_recently_updated'));
  r.register(makeSkill('github_by_author'));
  return r;
}

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

function toolUseResponse(name: string, input: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 12000 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function textResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('AnthropicClassifier.classify', () => {
  it('returns intent=tool for a tool_use response with name and input', async () => {
    const { fetchImpl } = captureCalls([
      () => toolUseResponse('github_count', { state: 'open', type: 'issue' }),
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    const result = await c.classify({
      utterance: 'how many open issues are there',
      registry: makeRegistry(),
    });
    expect(result).toEqual<ClassifierResult>({
      intent: 'tool',
      skillName: 'github_count',
      args: { state: 'open', type: 'issue' },
    });
  });

  it('returns intent=rag when the response is a text block only', async () => {
    const { fetchImpl } = captureCalls([() => textResponse("This isn't a tool query.")]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    const result = await c.classify({
      utterance: 'how does the sidecar handshake work',
      registry: makeRegistry(),
    });
    expect(result).toEqual({ intent: 'rag' });
  });

  it('LOAD-BEARING: returns intent=tool when content has BOTH a text preamble AND a tool_use block', async () => {
    const { fetchImpl } = captureCalls([
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_test',
            model: 'claude-haiku-4-5',
            content: [
              { type: 'text', text: 'Sure, let me count the open issues for you.' },
              { type: 'tool_use', id: 'toolu_1', name: 'github_count', input: { state: 'open' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    const result = await c.classify({
      utterance: 'count open issues',
      registry: makeRegistry(),
    });
    expect(result).toEqual({
      intent: 'tool',
      skillName: 'github_count',
      args: { state: 'open' },
    });
  });

  it('returns intent=tool with empty args when input is missing', async () => {
    const { fetchImpl } = captureCalls([
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_test',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'github_count' }],
            stop_reason: 'tool_use',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    const result = await c.classify({
      utterance: 'how many docs total',
      registry: makeRegistry(),
    });
    expect(result).toEqual({ intent: 'tool', skillName: 'github_count', args: {} });
  });

  it('returns intent=rag when the response has no content array', async () => {
    const { fetchImpl } = captureCalls([
      () =>
        new Response(JSON.stringify({ id: 'msg_test', stop_reason: 'end_turn' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    const result = await c.classify({ utterance: '', registry: makeRegistry() });
    expect(result).toEqual({ intent: 'rag' });
  });

  it('retries on 429 honoring Retry-After then succeeds', async () => {
    const retryWait: { waitMs: number; reason: string }[] = [];
    let attempts = 0;
    const { fetchImpl } = captureCalls([
      () => {
        attempts += 1;
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } });
      },
      () => {
        attempts += 1;
        return toolUseResponse('github_count', {});
      },
    ]);
    vi.useFakeTimers();
    const c = new AnthropicClassifier({
      apiKey: 'sk-test',
      fetchImpl,
      maxRetries: 4,
      onRetryWait: (info) => retryWait.push({ waitMs: info.waitMs, reason: info.reason }),
    });
    const promise = c.classify({ utterance: 'count docs', registry: makeRegistry() });
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    vi.useRealTimers();
    expect(attempts).toBe(2);
    expect(retryWait).toHaveLength(1);
    expect(retryWait[0]!.waitMs).toBeGreaterThanOrEqual(2000);
    expect(result).toEqual({ intent: 'tool', skillName: 'github_count', args: {} });
  });

  it('throws ClassifierProviderError(kind: rate-limit, retryAfterMs) after retries exhausted', async () => {
    const handlers = Array.from(
      { length: 4 },
      () => () => new Response('limited', { status: 429, headers: { 'retry-after': '0' } }),
    );
    const { fetchImpl } = captureCalls(handlers);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl, maxRetries: 4 });
    await expect(
      c.classify({ utterance: 'count docs', registry: makeRegistry() }),
    ).rejects.toMatchObject({
      constructor: ClassifierProviderError,
      kind: 'rate-limit',
      retryAfterMs: 0,
    });
  });

  it('throws ClassifierProviderError(auth-error) on 401 without retry', async () => {
    let attempts = 0;
    const { fetchImpl } = captureCalls([
      () => {
        attempts += 1;
        return new Response('bad key', { status: 401 });
      },
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    await expect(
      c.classify({ utterance: 'count', registry: makeRegistry() }),
    ).rejects.toMatchObject({
      constructor: ClassifierProviderError,
      kind: 'auth-error',
    });
    expect(attempts).toBe(1);
  });

  it('throws ClassifierProviderError(bad-request) on 400 without retry', async () => {
    const { fetchImpl } = captureCalls([
      () => new Response('bad body', { status: 400 }),
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    await expect(
      c.classify({ utterance: 'count', registry: makeRegistry() }),
    ).rejects.toMatchObject({
      constructor: ClassifierProviderError,
      kind: 'bad-request',
    });
  });

  it('throws AbortError when signal is aborted before the call settles', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = captureCalls([
      (req) => {
        if (req.signal.aborted) {
          return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
        return toolUseResponse('github_count', {});
      },
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    await expect(
      c.classify({ utterance: 'count', registry: makeRegistry() }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports cache_read_input_tokens via onUsage callback when present', async () => {
    const usage: { cacheReadTokens: number; cacheCreationTokens: number }[] = [];
    const { fetchImpl } = captureCalls([() => textResponse('rag')]);
    const c = new AnthropicClassifier({
      apiKey: 'sk-test',
      fetchImpl,
      onUsage: (u) => usage.push({ cacheReadTokens: u.cacheReadTokens, cacheCreationTokens: u.cacheCreationTokens }),
    });
    await c.classify({ utterance: 'explain', registry: makeRegistry() });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.cacheReadTokens).toBe(12000);
    expect(usage[0]!.cacheCreationTokens).toBe(0);
  });

  it('builds a request body with tools, tool_choice, cached system, and correct headers', async () => {
    const { calls, fetchImpl } = captureCalls([
      () => toolUseResponse('github_count', { state: 'open' }),
    ]);
    const c = new AnthropicClassifier({ apiKey: 'sk-test', fetchImpl });
    await c.classify({
      utterance: 'how many open',
      registry: makeRegistry(),
    });
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers.get('x-api-key')).toBe('sk-test');
    expect(req.headers.get('anthropic-version')).toBe(ANTHROPIC_VERSION);
    const body = (await req.json()) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(body.stream).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    const tools = body.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual([
      'github_count',
      'github_list',
      'github_recently_updated',
      'github_by_author',
    ]);
    const system = body.system as { type: string; cache_control?: unknown }[];
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sends bare utterance as user message when no context is supplied', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('github_count', { state: 'open' }),
    ]);
    const classifier = new AnthropicClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify({ utterance: 'how many open issues', registry: makeRegistry() });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toBe('how many open issues');
  });

  it('prepends meeting context to the user message when context is provided', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('github_count', { state: 'open' }),
    ]);
    const classifier = new AnthropicClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify({
      utterance: 'how many of those still open',
      registry: makeRegistry(),
      context: {
        current_topic: 'auth migration issues',
        open_questions: ['Should we backport to 1.x?'],
      },
    });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    const content = body.messages[0]!.content;
    expect(content).toContain('Meeting context so far:');
    expect(content).toContain('Current topic: auth migration issues');
    expect(content).toContain('Should we backport to 1.x?');
    expect(content).toContain('Utterance: how many of those still open');
    expect(content.indexOf('Meeting context')).toBeLessThan(content.indexOf('Utterance:'));
  });

  it('falls back to bare utterance when context is empty (no topic, no questions)', async () => {
    const { fetchImpl, calls } = captureCalls([
      () => toolUseResponse('github_count', {}),
    ]);
    const classifier = new AnthropicClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify({
      utterance: 'how many issues',
      registry: makeRegistry(),
      context: { current_topic: '', open_questions: [] },
    });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toBe('how many issues');
  });

  // U3 (router-boundary): the deterministic anchor is the REQUEST the classifier
  // sends — given recent_finals carrying the antecedent, the outbound user
  // message must include the recent-turns block + the antecedent text, so the
  // model has what it needs to resolve the anaphoric "these issues". (The model's
  // actual tool-vs-rag choice is non-deterministic and validated by replay.)
  it('threads recent_finals (the anaphora antecedent) into the request user message', async () => {
    const { fetchImpl, calls } = captureCalls([() => toolUseResponse('github_count', {})]);
    const classifier = new AnthropicClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify({
      utterance: 'how many of these issues are there',
      registry: makeRegistry(),
      context: { recent_finals: ['are there any open github issues'] },
    });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    const userMsg = body.messages[0]!.content;
    expect(userMsg).toContain('Recent turns (most recent last):');
    expect(userMsg).toContain('are there any open github issues');
    expect(userMsg).toContain('Utterance: how many of these issues are there');
  });

  it('back-compat: no finals + no summary → the request user message is the bare utterance (no recent-turns block)', async () => {
    const { fetchImpl, calls } = captureCalls([() => toolUseResponse('github_count', {})]);
    const classifier = new AnthropicClassifier({ apiKey: 'k', fetchImpl });
    await classifier.classify({ utterance: 'how many issues are there', registry: makeRegistry() });
    const body = (await calls[0]!.json()) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toBe('how many issues are there');
    expect(body.messages[0]!.content).not.toContain('Recent turns');
  });
});
