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
  readonly url: string;
  readonly dateLastActivity: string | null;
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

/** Page through a list endpoint using the `before=<lastId>` cursor. */
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
    const last = page[page.length - 1];
    if (last === undefined) break;
    before = last.id;
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

/**
 * Non-archived cards on a board, with their list name resolved. Excludes closed
 * cards and cards on archived (closed) lists — the documented `filter` gotcha.
 */
export async function fetchBoardCards(boardId: string, opts: TrelloClientOptions): Promise<TrelloCard[]> {
  const lists = await trelloGet<Array<{ id: string; name: string; closed: boolean }>>(
    `/boards/${boardId}/lists`,
    { filter: 'all', fields: 'name,closed' },
    opts,
  );
  const listById = new Map(lists.map((l) => [l.id, l]));
  const archivedListIds = new Set(lists.filter((l) => l.closed).map((l) => l.id));

  const rawCards = await paginate<{
    id: string;
    name: string;
    desc: string;
    idList: string;
    url: string;
    shortUrl: string;
    dateLastActivity: string | null;
    closed: boolean;
  }>(
    `/boards/${boardId}/cards`,
    { filter: 'visible', fields: 'name,desc,idList,url,shortUrl,dateLastActivity,closed' },
    opts,
  );

  return rawCards
    .filter((c) => !c.closed && !archivedListIds.has(c.idList))
    .map((c) => ({
      id: c.id,
      name: c.name,
      desc: c.desc ?? '',
      listId: c.idList,
      listName: listById.get(c.idList)?.name ?? '',
      url: c.shortUrl ?? c.url,
      dateLastActivity: c.dateLastActivity ?? null,
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
