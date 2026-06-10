import { describe, expect, it } from 'vitest';
import {
  EmbeddingProviderError,
  EmbeddingRateLimitError,
  type EmbedItem,
} from '../../src/embed/contract.js';
import {
  DEFAULT_VOYAGE_CODE_MODEL,
  DEFAULT_VOYAGE_DIMENSION,
  DEFAULT_VOYAGE_TEXT_MODEL,
  MAX_INPUTS_PER_REQUEST,
  VoyageEmbedder,
} from '../../src/embed/voyage.js';
import { EmbedCache } from '../../src/embed/cache.js';

function fakeEmbeddings(count: number): number[][] {
  return Array.from({ length: count }, (_, i) => {
    const v = new Array<number>(DEFAULT_VOYAGE_DIMENSION).fill(0);
    v[i % DEFAULT_VOYAGE_DIMENSION] = 1;
    return v;
  });
}

interface CallLog {
  body: { model: string; input: string[] };
}

function captureCalls(returnEmbeddings: (count: number) => number[][]): {
  fetch: typeof fetch;
  calls: CallLog[];
} {
  const calls: CallLog[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    const body = JSON.parse(init?.body as string) as { model: string; input: string[] };
    calls.push({ body });
    const embeddings = returnEmbeddings(body.input.length);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: embeddings.map((embedding, index) => ({ index, embedding })),
          usage: { total_tokens: body.input.reduce((acc, t) => acc + t.length, 0) },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  };
  return { fetch: fetchImpl, calls };
}

describe('VoyageEmbedder', () => {
  it('routes text/code items to the correct model', async () => {
    const { fetch: fetchImpl, calls } = captureCalls(fakeEmbeddings);
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl });
    const items: EmbedItem[] = [
      { text: 'hello text', domain: 'text' },
      { text: 'function foo() {}', domain: 'code' },
    ];
    const result = await embedder.embed({ items });
    expect(result.vectors).toHaveLength(2);
    const models = calls.map((c) => c.body.model);
    expect(models).toContain(DEFAULT_VOYAGE_TEXT_MODEL);
    expect(models).toContain(DEFAULT_VOYAGE_CODE_MODEL);
  });

  it('splits oversized domain groups into ≤128-input requests and stitches vectors in order', async () => {
    const calls: string[][] = [];
    // Encode each input's numeric text into embedding[0] so order is verifiable.
    const fetchImpl: typeof fetch = (_input, init) => {
      const body = JSON.parse(init?.body as string) as { input: string[] };
      calls.push(body.input);
      const data = body.input.map((text, index) => {
        const v = new Array<number>(DEFAULT_VOYAGE_DIMENSION).fill(0);
        v[0] = Number(text);
        return { index, embedding: v };
      });
      return Promise.resolve(
        new Response(JSON.stringify({ data, usage: { total_tokens: body.input.length } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl });
    const count = MAX_INPUTS_PER_REQUEST + 5;
    const items: EmbedItem[] = Array.from({ length: count }, (_, i) => ({
      text: String(i),
      domain: 'text' as const,
    }));
    const result = await embedder.embed({ items });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(MAX_INPUTS_PER_REQUEST);
    expect(calls[1]).toHaveLength(5);
    expect(result.vectors).toHaveLength(count);
    for (let i = 0; i < count; i += 1) {
      expect(result.vectors[i]?.vector[0]).toBe(i);
    }
    expect(result.inputTokens).toBe(count);
  });

  it('returns vectors with the configured dimension', async () => {
    const { fetch: fetchImpl } = captureCalls(fakeEmbeddings);
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl });
    const result = await embedder.embed({ items: [{ text: 'a', domain: 'text' }] });
    expect(result.dimension).toBe(DEFAULT_VOYAGE_DIMENSION);
    expect(result.vectors[0]?.vector.length).toBe(DEFAULT_VOYAGE_DIMENSION);
  });

  it('serves repeat requests from the cache', async () => {
    const { fetch: fetchImpl, calls } = captureCalls(fakeEmbeddings);
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl, cache: new EmbedCache() });
    const items: EmbedItem[] = [{ text: 'hello', domain: 'text' }];
    const first = await embedder.embed({ items });
    expect(first.cacheHits).toBe(0);
    expect(first.vectors[0]?.cached).toBe(false);
    const second = await embedder.embed({ items });
    expect(second.cacheHits).toBe(1);
    expect(second.vectors[0]?.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('returns empty result for empty input batch', async () => {
    const { fetch: fetchImpl, calls } = captureCalls(fakeEmbeddings);
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl });
    const result = await embedder.embed({ items: [] });
    expect(result.vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: new Array(DEFAULT_VOYAGE_DIMENSION).fill(0) }],
            usage: { total_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl, maxRetries: 3 });
    const result = await embedder.embed({ items: [{ text: 'x', domain: 'text' }] });
    expect(result.vectors).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('raises EmbeddingRateLimitError after all retries fail with 429', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
      );
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl, maxRetries: 2 });
    await expect(embedder.embed({ items: [{ text: 'x', domain: 'text' }] })).rejects.toBeInstanceOf(
      EmbeddingRateLimitError,
    );
  });

  it('raises EmbeddingProviderError on 500', async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response('boom', { status: 500 }));
    const embedder = new VoyageEmbedder({ apiKey: 'k', fetchImpl, maxRetries: 1 });
    await expect(embedder.embed({ items: [{ text: 'x', domain: 'text' }] })).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );
  });

  it('reports inputTokens via onUsage callback', async () => {
    const usageEvents: { model: string; inputTokens: number }[] = [];
    const { fetch: fetchImpl } = captureCalls(fakeEmbeddings);
    const embedder = new VoyageEmbedder({
      apiKey: 'k',
      fetchImpl,
      onUsage: (u) => usageEvents.push({ model: u.model, inputTokens: u.inputTokens }),
    });
    await embedder.embed({
      items: [
        { text: 'hello', domain: 'text' },
        { text: 'world', domain: 'text' },
      ],
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.inputTokens).toBeGreaterThan(0);
  });
});
