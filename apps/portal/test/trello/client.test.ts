import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBoardCards,
  fetchCardComments,
  listBoards,
  type TrelloClientOptions,
} from '../../app/_lib/trello-client';
import { TrelloAuthError } from '../../app/_lib/trello';

const opts: TrelloClientOptions = { token: 'tok', apiKey: 'key', sleep: async () => undefined };

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

/** Route fetch by URL substring; each route yields its queued responses in order. */
function routeFetch(routes: Array<{ match: string; responses: Response[] }>): void {
  const cursors = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) throw new Error(`no mock route for ${url}`);
    const i = cursors.get(route.match) ?? 0;
    cursors.set(route.match, i + 1);
    const res = route.responses[Math.min(i, route.responses.length - 1)];
    return res!.clone();
  });
}

afterEach(() => vi.restoreAllMocks());

describe('listBoards', () => {
  it('maps board fields', async () => {
    routeFetch([
      {
        match: '/members/me/boards',
        responses: [
          json([
            { id: 'b1', name: 'Roadmap', url: 'https://trello.com/b/b1', idOrganization: 'o1', dateLastActivity: '2026-05-30T00:00:00Z' },
          ]),
        ],
      },
    ]);
    const boards = await listBoards(opts);
    expect(boards).toEqual([
      { id: 'b1', name: 'Roadmap', url: 'https://trello.com/b/b1', idOrganization: 'o1', dateLastActivity: '2026-05-30T00:00:00Z' },
    ]);
  });
});

describe('fetchBoardCards', () => {
  it('excludes closed cards and cards on archived lists, resolving list names', async () => {
    routeFetch([
      {
        match: '/lists',
        responses: [
          json([
            { id: 'L_open', name: 'Doing', closed: false },
            { id: 'L_arch', name: 'Old', closed: true },
          ]),
        ],
      },
      {
        match: '/members',
        responses: [json([{ id: 'm1', fullName: 'Priya Patel' }])],
      },
      {
        match: '/cards',
        responses: [
          json([
            { id: 'c1', name: 'Live card', desc: 'd1', idList: 'L_open', idMembers: ['m1'], url: 'u1', shortUrl: 's1', dateLastActivity: null, closed: false },
            { id: 'c2', name: 'Closed card', desc: '', idList: 'L_open', url: 'u2', shortUrl: 's2', dateLastActivity: null, closed: true },
            { id: 'c3', name: 'On archived list', desc: '', idList: 'L_arch', url: 'u3', shortUrl: 's3', dateLastActivity: null, closed: false },
          ]),
        ],
      },
    ]);
    const cards = await fetchBoardCards('b1', opts);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'c1',
      name: 'Live card',
      desc: 'd1',
      listId: 'L_open',
      listName: 'Doing',
      members: ['Priya Patel'],
      url: 's1',
    });
  });

  it('paginates with the minimum-id before cursor until a short page returns', async () => {
    // Page comes back in NON-descending id order on purpose: the cursor must
    // be the MINIMUM id in the page (correct under either ordering), not the
    // last element — pages are only last-element-correct when id-descending.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `id${String(i).padStart(4, '0')}`, name: `Card ${i}`, desc: '', idList: 'L', url: '', shortUrl: `s${i}`, dateLastActivity: null, closed: false,
    }));
    const shortPage = [
      { id: 'id9999', name: 'Last', desc: '', idList: 'L', url: '', shortUrl: 'sLast', dateLastActivity: null, closed: false },
    ];
    let secondCardCallUrl = '';
    const cursors = new Map<string, number>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/lists')) return json([{ id: 'L', name: 'List', closed: false }]);
      if (url.includes('/members')) return json([]);
      // cards endpoint, paginated
      const i = cursors.get('cards') ?? 0;
      cursors.set('cards', i + 1);
      if (i === 0) return json(fullPage);
      secondCardCallUrl = url;
      return json(shortPage);
    });

    const cards = await fetchBoardCards('b1', opts);
    expect(cards).toHaveLength(1001);
    // The 2nd cards request carries the MIN id of page 1 as the before cursor.
    expect(secondCardCallUrl).toContain('before=id0000');
  });
});

describe('fetchCardComments', () => {
  it('maps comment text, author, and date; empty card yields []', async () => {
    routeFetch([
      {
        match: '/actions',
        responses: [
          json([
            { id: 'a1', date: '2026-05-29T10:00:00Z', data: { text: 'ship it' }, memberCreator: { fullName: 'Priya' } },
            { id: 'a2', date: '2026-05-29T11:00:00Z', data: { text: 'lgtm' }, memberCreator: { username: 'marco' } },
          ]),
        ],
      },
    ]);
    const comments = await fetchCardComments('c1', opts);
    expect(comments).toEqual([
      { id: 'a1', text: 'ship it', author: 'Priya', date: '2026-05-29T10:00:00Z' },
      { id: 'a2', text: 'lgtm', author: 'marco', date: '2026-05-29T11:00:00Z' },
    ]);

    routeFetch([{ match: '/actions', responses: [json([])] }]);
    expect(await fetchCardComments('c2', opts)).toEqual([]);
  });
});

describe('rate limit + auth handling', () => {
  it('backs off on 429 (honoring the interval header) and retries', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate', { status: 429, headers: { 'x-rate-limit-api-token-interval-ms': '5' } });
      }
      return json([{ id: 'b1', name: 'B', url: '', idOrganization: null, dateLastActivity: null }]);
    });
    const boards = await listBoards(opts);
    expect(calls).toBe(2);
    expect(boards).toHaveLength(1);
  });

  it('raises TrelloAuthError on 401 without retry', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return new Response('invalid token', { status: 401 });
    });
    await expect(listBoards(opts)).rejects.toBeInstanceOf(TrelloAuthError);
    expect(calls).toBe(1);
  });
});
