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
});
