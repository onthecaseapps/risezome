import type { SkillContext } from '@risezome/engine/skills';
import { TrelloClient } from '../../../src/skills/trello/client.js';
import type { TrelloLiveContext } from '../../../src/skills/trello/live-context.js';
import type { TrelloAccess } from '../../../src/skills/trello/source-resolver.js';

/** Fixed "now" so due/recency tests are deterministic. */
export const NOW = Date.parse('2026-06-01T00:00:00Z');

export const SKILL_CTX: SkillContext = {
  db: null as never,
  orgId: 'test-org',
  now: () => NOW,
};

export interface ListFixture {
  readonly id: string;
  readonly name: string;
  readonly closed?: boolean;
}
export interface CardFixture {
  readonly id: string;
  readonly name: string;
  readonly desc?: string;
  readonly idList: string;
  readonly idMembers?: readonly string[];
  readonly idLabels?: readonly string[];
  readonly due?: string | null;
  readonly dueComplete?: boolean;
  readonly shortUrl?: string;
  readonly dateLastActivity?: string | null;
  readonly closed?: boolean;
}
export interface BoardFixture {
  readonly id: string;
  readonly name: string;
  readonly lists: readonly ListFixture[];
  readonly members?: readonly { id: string; fullName?: string; username?: string }[];
  readonly labels?: readonly { id: string; name: string }[];
  readonly cards: readonly CardFixture[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A fetch impl that serves the given board fixtures from Trello's endpoints. */
export function trelloFetch(boards: readonly BoardFixture[]): typeof fetch {
  const byId = new Map(boards.map((b) => [b.id, b]));
  return ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const m = /\/1\/boards\/([^/]+)\/(lists|members|labels|cards)/.exec(parsed.pathname);
    if (m === null) throw new Error(`unexpected trello url: ${url}`);
    const board = byId.get(m[1]!);
    if (board === undefined) throw new Error(`unknown board in url: ${url}`);
    switch (m[2]) {
      case 'lists': {
        const filter = parsed.searchParams.get('filter');
        const lists = board.lists
          .filter((l) => (filter === 'open' ? l.closed !== true : true))
          .map((l) => ({ id: l.id, name: l.name, closed: l.closed === true }));
        return Promise.resolve(jsonResponse(lists));
      }
      case 'members':
        return Promise.resolve(jsonResponse(board.members ?? []));
      case 'labels':
        return Promise.resolve(jsonResponse(board.labels ?? []));
      case 'cards':
        // Fixtures stay well under the 1000 page cap, so a single page ends pagination.
        return Promise.resolve(jsonResponse(board.cards));
      default:
        throw new Error(`unhandled resource: ${url}`);
    }
  });
}

export function trelloCtx(boards: readonly BoardFixture[], accessBoards?: TrelloAccess['boards']): TrelloLiveContext {
  const client = new TrelloClient({ apiKey: 'test-key', fetchImpl: trelloFetch(boards) });
  const access: TrelloAccess = {
    token: 'test-token',
    boards: accessBoards ?? boards.map((b) => ({ id: b.id, name: b.name })),
  };
  return { client, resolve: async () => access };
}

export function trelloCtxNoSource(): TrelloLiveContext {
  const client = new TrelloClient({ apiKey: 'test-key', fetchImpl: trelloFetch([]) });
  return { client, resolve: async () => null };
}

/** A representative single-board fixture reused across skill tests. */
export const ROADMAP: BoardFixture = {
  id: 'b1',
  name: 'Roadmap',
  lists: [
    { id: 'l1', name: 'Backlog' },
    { id: 'l2', name: 'Doing' },
    { id: 'l3', name: 'Done' },
    { id: 'l4', name: 'Old', closed: true },
  ],
  members: [
    { id: 'm1', fullName: 'Alice Smith' },
    { id: 'm2', fullName: 'Bob Lee' },
  ],
  labels: [
    { id: 'lb1', name: 'bug' },
    { id: 'lb2', name: 'feature' },
    { id: 'lb3', name: '' }, // color-only label — dropped from card.labels
  ],
  cards: [
    {
      id: 'c1',
      name: 'Fix login',
      idList: 'l2',
      idMembers: ['m1'],
      idLabels: ['lb1'],
      due: '2026-05-01T00:00:00Z', // overdue vs NOW
      dueComplete: false,
      shortUrl: 'https://trello.com/c/c1',
      dateLastActivity: '2026-05-30T00:00:00Z',
    },
    {
      id: 'c2',
      name: 'Add export',
      idList: 'l1',
      idMembers: ['m2'],
      idLabels: ['lb2'],
      due: '2026-07-01T00:00:00Z', // upcoming
      shortUrl: 'https://trello.com/c/c2',
      dateLastActivity: '2026-05-20T00:00:00Z',
    },
    {
      id: 'c3',
      name: 'Write docs',
      idList: 'l1',
      idMembers: ['m1', 'm2'],
      idLabels: ['lb3'],
      due: null, // no due date
      shortUrl: 'https://trello.com/c/c3',
      dateLastActivity: '2026-05-25T00:00:00Z',
    },
    {
      id: 'c4',
      name: 'Ship v1',
      idList: 'l3',
      idMembers: [],
      idLabels: ['lb1'],
      due: '2026-04-01T00:00:00Z',
      dueComplete: true, // due-complete
      shortUrl: 'https://trello.com/c/c4',
      dateLastActivity: '2026-04-02T00:00:00Z',
    },
    {
      id: 'c5',
      name: 'Archived work',
      idList: 'l4', // on an archived list → excluded
      idMembers: ['m1'],
      dateLastActivity: '2026-05-31T00:00:00Z',
    },
    {
      id: 'c6',
      name: 'Deleted card',
      idList: 'l2',
      closed: true, // closed card → excluded
      dateLastActivity: '2026-05-31T00:00:00Z',
    },
  ],
};
