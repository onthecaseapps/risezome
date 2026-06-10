import { describe, expect, it } from 'vitest';
import { TrelloClient } from '../../../src/skills/trello/client.js';
import { ConnectorAuthError, RateLimitedError } from '../../../src/skills/github/connector-errors.js';
import { trelloFetch, ROADMAP } from './_ctx.js';

describe('TrelloClient', () => {
  it('enriches cards with list/member/label names and excludes archived + closed', async () => {
    const client = new TrelloClient({ apiKey: 'k', fetchImpl: trelloFetch([ROADMAP]) });
    const cards = await client.fetchEnrichedCards('b1', 'tok');
    // c5 (archived list) and c6 (closed) are excluded.
    expect(cards.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
    const fixLogin = cards.find((c) => c.id === 'c1');
    expect(fixLogin?.listName).toBe('Doing');
    expect(fixLogin?.members).toEqual(['Alice Smith']);
    expect(fixLogin?.labels).toEqual(['bug']);
    // The empty (color-only) label lb3 on c3 is dropped.
    expect(cards.find((c) => c.id === 'c3')?.labels).toEqual([]);
  });

  it('orders board list counts by column position, including empty columns', async () => {
    const board = {
      ...ROADMAP,
      cards: ROADMAP.cards.filter((c) => c.idList !== 'l1'), // empty Backlog
    };
    const client = new TrelloClient({ apiKey: 'k', fetchImpl: trelloFetch([board]) });
    const counts = await client.fetchBoardListCounts('b1', 'tok');
    expect(counts).toEqual([
      { listName: 'Backlog', count: 0 },
      { listName: 'Doing', count: 1 },
      { listName: 'Done', count: 1 },
    ]);
  });

  it('maps a 401 to ConnectorAuthError without leaking the token', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(new Response('nope', { status: 401 })));
    const client = new TrelloClient({ apiKey: 'secret-key', fetchImpl });
    await expect(client.fetchEnrichedCards('b1', 'secret-token')).rejects.toBeInstanceOf(ConnectorAuthError);
    await expect(client.fetchEnrichedCards('b1', 'secret-token')).rejects.toMatchObject({ status: 401 });
    await expect(client.fetchEnrichedCards('b1', 'secret-token')).rejects.not.toThrowError(/secret-token/);
  });

  it('retries on 429 then surfaces RateLimitedError when exhausted', async () => {
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        new Response('slow down', {
          status: 429,
          headers: { 'x-rate-limit-api-token-interval-ms': '1' },
        }),
      ));
    const client = new TrelloClient({ apiKey: 'k', fetchImpl, sleep: async () => {} });
    await expect(client.fetchEnrichedCards('b1', 'tok')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('threads the signal into fetch', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const inner = trelloFetch([ROADMAP]);
    const fetchImpl: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      return inner(input as string);
    }) as typeof fetch;
    const controller = new AbortController();
    const client = new TrelloClient({ apiKey: 'k', fetchImpl });
    await client.fetchEnrichedCards('b1', 'tok', controller.signal);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toBe(controller.signal);
  });

  it('aborts the 429 backoff sleep instead of waiting it out', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = (() =>
      Promise.resolve(
        new Response('slow down', {
          status: 429,
          headers: { 'x-rate-limit-api-token-interval-ms': '60000' },
        }),
      ));
    let sleptMs = 0;
    // A sleep that never resolves on its own — the abort race must win.
    const hangingSleep = (ms: number): Promise<void> => {
      sleptMs = ms;
      return new Promise<void>(() => {});
    };
    const client = new TrelloClient({ apiKey: 'k', fetchImpl, sleep: hangingSleep });
    const pending = client.fetchEnrichedCards('b1', 'tok', controller.signal);
    const settled = expect(pending).rejects.toThrow(/aborted/i);
    // Let the first fetch + backoff begin, then abort mid-sleep.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await settled;
    expect(sleptMs).toBe(60000);
  });

  it('pages with the MINIMUM id in the page as the before cursor', async () => {
    // 1000-card first page in NON-descending order: the min-id cursor is
    // correct under either ordering; a last-element cursor would drop the
    // newest cards whenever the page is not id-descending.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `id${String(i).padStart(4, '0')}`,
      name: `Card ${i}`,
      idList: 'l1',
      closed: false,
    }));
    const shortPage = [{ id: 'id9999', name: 'Last', idList: 'l1', closed: false }];
    let cardCalls = 0;
    let secondCardUrl = '';
    const fetchImpl: typeof fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/lists')) return Promise.resolve(json([{ id: 'l1', name: 'Doing', closed: false }]));
      if (url.includes('/members')) return Promise.resolve(json([]));
      if (url.includes('/labels')) return Promise.resolve(json([]));
      cardCalls += 1;
      if (cardCalls === 1) return Promise.resolve(json(fullPage));
      secondCardUrl = url;
      return Promise.resolve(json(shortPage));
    }) as typeof fetch;
    const client = new TrelloClient({ apiKey: 'k', fetchImpl });
    const cards = await client.fetchEnrichedCards('b1', 'tok');
    expect(cards).toHaveLength(1001);
    expect(secondCardUrl).toContain('before=id0000');
  });
});
