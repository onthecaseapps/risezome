import { describe, expect, it, vi } from 'vitest';
import { makeVoyageReranker } from '../../src/embed/voyage-rerank.js';

function mockFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

describe('makeVoyageReranker', () => {
  it('returns results sorted by relevance score, best-first', async () => {
    const fetchImpl = mockFetch({
      data: [
        { index: 0, relevance_score: 0.2 },
        { index: 1, relevance_score: 0.9 },
        { index: 2, relevance_score: 0.5 },
      ],
    });
    const rerank = makeVoyageReranker({ apiKey: 'k', fetchImpl });
    const out = await rerank('q', ['a', 'b', 'c']);
    expect(out.map((r) => r.index)).toEqual([1, 2, 0]);
    expect(out[0]!.score).toBe(0.9);
  });

  it('returns [] for an empty document set without calling the API', async () => {
    const fetchImpl = mockFetch({});
    const rerank = makeVoyageReranker({ apiKey: 'k', fetchImpl });
    expect(await rerank('q', [])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-ok response (caller degrades to RRF order)', async () => {
    const rerank = makeVoyageReranker({ apiKey: 'k', fetchImpl: mockFetch({}, false) });
    await expect(rerank('q', ['a'])).rejects.toThrow(/voyage rerank failed/);
  });

  it('passes top_k and a steering instruction into the request', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, relevance_score: 1 }] }),
      _init: init,
    })) as unknown as typeof fetch;
    const rerank = makeVoyageReranker({ apiKey: 'k', fetchImpl, instruction: 'prefer docs over tests' });
    await rerank('what models', ['a', 'b'], { topK: 1 });
    const body = JSON.parse((fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0]![1].body) as {
      query: string;
      top_k: number;
      model: string;
    };
    expect(body.query).toContain('prefer docs over tests');
    expect(body.query).toContain('what models');
    expect(body.top_k).toBe(1);
    expect(body.model).toBe('rerank-2.5');
  });

  it('drops malformed result rows', async () => {
    const rerank = makeVoyageReranker({
      apiKey: 'k',
      fetchImpl: mockFetch({ data: [{ index: 0, relevance_score: 0.5 }, { index: 'x' }, { relevance_score: 0.9 }] }),
    });
    const out = await rerank('q', ['a', 'b', 'c']);
    expect(out).toEqual([{ index: 0, score: 0.5 }]);
  });
});
