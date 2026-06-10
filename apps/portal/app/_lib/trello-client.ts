/**
 * Trello read client: lists boards, and a board's non-archived cards with
 * descriptions and comments. Read-only; used by the Trello indexer and the
 * Sources board picker.
 *
 * Behaviours that matter (see plan KTD6 + Trello API research):
 *   - Archived exclusion: `filter=open`/`visible` does NOT exclude cards on
 *     archived lists. We fetch lists with `filter=all`, then drop cards whose
 *     `idList` is archived (and any card with `closed=true`).
 *   - Stable id: cards are keyed by the immutable `id`, never `idShort` (which
 *     regenerates when a card moves boards).
 *   - Pagination: Trello caps results at 1000 and has no total count; we page
 *     with the `before=<lastId>` cursor until a short page returns.
 *   - Rate limits: 100 req/10s per token; on 429 we back off honoring the
 *     `x-rate-limit-api-token-interval-ms` header, then retry.
 *   - Auth: a 401 raises `TrelloAuthError` (never retried).
 */

import { TRELLO_API_BASE, TrelloAuthError } from './trello';

const PAGE_LIMIT = 1000;
const MAX_RETRIES = 4;

export interface TrelloBoard {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly idOrganization: string | null;
  readonly dateLastActivity: string | null;
}

export interface TrelloCard {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly listId: string;
  readonly listName: string;
  /** Member display names (fullName, falling back to username). */
  readonly members: readonly string[];
  readonly url: string;
  readonly dateLastActivity: string | null;
  /** True when the card is closed (archived) or sits on an archived list.
   *  Always false unless fetched with `includeArchived`. */
  readonly archived: boolean;
}

export interface TrelloComment {
  readonly id: string;
  readonly text: string;
  readonly author: string | null;
  readonly date: string | null;
}

/** Injectable sleep so tests don't wait real seconds on backoff. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface TrelloClientOptions {
  readonly token: string;
  readonly apiKey: string;
  readonly sleep?: Sleep;
}

/**
 * Single authenticated GET with rate-limit backoff + auth handling. Returns
 * parsed JSON of type T. 401 → TrelloAuthError; 429 → backoff + retry.
 */
async function trelloGet<T>(
  path: string,
  query: Record<string, string>,
  opts: TrelloClientOptions,
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const params = new URLSearchParams({ ...query, key: opts.apiKey, token: opts.token });
  const url = `${TRELLO_API_BASE}${path}?${params.toString()}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(url);
    if (res.status === 401) throw new TrelloAuthError();
    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error('Trello rate limit exceeded after retries');
      }
      const intervalMs = Number.parseInt(
        res.headers.get('x-rate-limit-api-token-interval-ms') ?? '',
        10,
      );
      const waitMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Trello GET ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
  // Unreachable (loop returns or throws), but satisfies the type checker.
  throw new Error('Trello GET exhausted retries');
}

/** Page through a list endpoint using the `before=<minId>` cursor. */
async function paginate<T extends { id: string }>(
  path: string,
  query: Record<string, string>,
  opts: TrelloClientOptions,
): Promise<T[]> {
  const all: T[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await trelloGet<T[]>(
      path,
      { ...query, limit: String(PAGE_LIMIT), ...(before !== undefined ? { before } : {}) },
      opts,
    );
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    // Cursor = the MINIMUM id in the page, not the last element. Trello ids
    // are monotonically increasing fixed-length hex, so the min is the page's
    // oldest item; using the last element is only correct when pages come
    // back id-descending — if they don't, the newest cards silently fall
    // outside every subsequent `before` window and are dropped.
    const minId = page.reduce<string | undefined>(
      (min, item) => (min === undefined || item.id < min ? item.id : min),
      undefined,
    );
    if (minId === undefined) break;
    before = minId;
  }
  return all;
}

/** Boards the token's member belongs to (open boards only). */
export async function listBoards(opts: TrelloClientOptions): Promise<TrelloBoard[]> {
  const raw = await trelloGet<
    Array<{ id: string; name: string; url: string; idOrganization: string | null; dateLastActivity: string | null }>
  >(
    '/members/me/boards',
    { filter: 'open', fields: 'name,url,idOrganization,dateLastActivity' },
    opts,
  );
  return raw.map((b) => ({
    id: b.id,
    name: b.name,
    url: b.url,
    idOrganization: b.idOrganization ?? null,
    dateLastActivity: b.dateLastActivity ?? null,
  }));
}

/** Names of a board's open (non-archived) lists, for the filtering editor. */
export async function fetchBoardLists(boardId: string, opts: TrelloClientOptions): Promise<string[]> {
  const raw = await trelloGet<Array<{ name: string }>>(
    `/boards/${boardId}/lists`,
    { filter: 'open', fields: 'name' },
    opts,
  );
  return raw.map((l) => l.name).filter((n) => n.length > 0);
}

export interface FetchBoardCardsOptions {
  /**
   * Include completed/archived cards. When false (default) closed cards and
   * cards on archived (closed) lists are dropped at fetch — the documented
   * `filter` gotcha. When true, ALL cards are fetched and each carries an
   * `archived` flag so the caller (corpus policy) can decide. Set by a
   * per-source Trello override ("Index completed cards").
   */
  readonly includeArchived?: boolean;
}

/**
 * Cards on a board, with their list name resolved. By default excludes closed
 * cards and cards on archived (closed) lists; `includeArchived` fetches them
 * too, flagged via `archived`.
 */
export async function fetchBoardCards(
  boardId: string,
  opts: TrelloClientOptions,
  cardOpts: FetchBoardCardsOptions = {},
): Promise<TrelloCard[]> {
  const includeArchived = cardOpts.includeArchived === true;
  const [lists, boardMembers] = await Promise.all([
    trelloGet<Array<{ id: string; name: string; closed: boolean }>>(
      `/boards/${boardId}/lists`,
      { filter: 'all', fields: 'name,closed' },
      opts,
    ),
    trelloGet<Array<{ id: string; fullName?: string; username?: string }>>(
      `/boards/${boardId}/members`,
      { fields: 'fullName,username' },
      opts,
    ),
  ]);
  const listById = new Map(lists.map((l) => [l.id, l]));
  const archivedListIds = new Set(lists.filter((l) => l.closed).map((l) => l.id));
  const memberById = new Map(boardMembers.map((m) => [m.id, m.fullName ?? m.username ?? m.id]));

  const rawCards = await paginate<{
    id: string;
    name: string;
    desc: string;
    idList: string;
    idMembers?: readonly string[];
    url: string;
    shortUrl: string;
    dateLastActivity: string | null;
    closed: boolean;
  }>(
    `/boards/${boardId}/cards`,
    // `all` returns closed cards too; `visible` omits them. Lists are always
    // fetched with filter=all so we can still tag (or drop) archived-list cards.
    { filter: includeArchived ? 'all' : 'visible', fields: 'name,desc,idList,idMembers,url,shortUrl,dateLastActivity,closed' },
    opts,
  );

  return rawCards
    .filter((c) => includeArchived || (!c.closed && !archivedListIds.has(c.idList)))
    .map((c) => ({
      id: c.id,
      name: c.name,
      desc: c.desc ?? '',
      listId: c.idList,
      listName: listById.get(c.idList)?.name ?? '',
      members: (c.idMembers ?? []).map((id) => memberById.get(id) ?? id),
      url: c.shortUrl ?? c.url,
      dateLastActivity: c.dateLastActivity ?? null,
      archived: c.closed || archivedListIds.has(c.idList),
    }));
}

/** Comments on a card, oldest-to-newest as returned. */
export async function fetchCardComments(cardId: string, opts: TrelloClientOptions): Promise<TrelloComment[]> {
  const raw = await paginate<{
    id: string;
    date: string;
    data: { text?: string };
    memberCreator: { fullName?: string; username?: string } | null;
  }>(`/cards/${cardId}/actions`, { filter: 'commentCard' }, opts);

  return raw.map((a) => ({
    id: a.id,
    text: a.data.text ?? '',
    author: a.memberCreator?.fullName ?? a.memberCreator?.username ?? null,
    date: a.date ?? null,
  }));
}
