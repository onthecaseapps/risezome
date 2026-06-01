/**
 * Trello read client for the live skills. Fetches a board's non-archived cards
 * enriched with their list (column) name, member display names, and label
 * names — everything the skill filters need — in a handful of GETs per board.
 *
 * Mirrors the portal's read client (apps/portal/app/_lib/trello-client.ts) but
 * packaged as an injectable class (fetch + sleep) so skills can be unit-tested
 * without real HTTP, and extended with members/labels/due since the skills
 * filter on them. Behaviours that matter (Trello API quirks):
 *
 *   - Archived exclusion: `filter=open`/`visible` does NOT drop cards on
 *     archived lists. We fetch lists with `filter=all`, then drop cards whose
 *     `idList` is archived (and any `closed` card).
 *   - Stable id: cards are keyed by the immutable `id`, never `idShort`.
 *   - Pagination: Trello caps at 1000 with no total; page via `before=<lastId>`.
 *   - Rate limits: 100 req/10s per token; on 429 back off honoring the
 *     `x-rate-limit-api-token-interval-ms` header, then retry.
 *   - Auth: a 401 raises ConnectorAuthError(status:401) — never retried.
 *
 * Reuses the connector-generic error classes + token redaction from the github
 * folder (the comment there flags them as a future shared connector package).
 */

import { ConnectorAuthError, RateLimitedError } from '../github/connector-errors.js';
import { redactString } from '../github/log-redaction.js';

export const TRELLO_API_BASE = 'https://api.trello.com/1';
const PAGE_LIMIT = 1000;
const MAX_RETRIES = 4;

/** A board's card after list/member/label enrichment — the skill filter input. */
export interface EnrichedCard {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  /** Column the card sits in (resolved from idList). */
  readonly listName: string;
  /** Member display names (fullName, falling back to username). */
  readonly members: readonly string[];
  /** Label names (color-only labels with empty names are dropped). */
  readonly labels: readonly string[];
  /** Due date ISO string, or null if the card has no due date. */
  readonly due: string | null;
  readonly dueComplete: boolean;
  readonly url: string;
  readonly dateLastActivity: string | null;
}

/** Injectable sleep so tests don't wait real seconds on backoff. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface TrelloClientOptions {
  /** Platform Power-Up API key (TRELLO_API_KEY). Shared across orgs. */
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: Sleep;
}

interface RawList {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
}
interface RawMember {
  readonly id: string;
  readonly fullName?: string;
  readonly username?: string;
}
interface RawLabel {
  readonly id: string;
  readonly name: string;
}
interface RawCard {
  readonly id: string;
  readonly name: string;
  readonly desc?: string;
  readonly idList: string;
  readonly idMembers?: readonly string[];
  readonly idLabels?: readonly string[];
  readonly due?: string | null;
  readonly dueComplete?: boolean;
  readonly url?: string;
  readonly shortUrl?: string;
  readonly dateLastActivity?: string | null;
  readonly closed?: boolean;
}

export class TrelloClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: Sleep;

  constructor(options: TrelloClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#sleep = options.sleep ?? realSleep;
  }

  /**
   * All non-archived cards on a board, enriched with list/member/label names.
   * Four reads per board: lists, members, labels, then the paged card list.
   */
  async fetchEnrichedCards(boardId: string, token: string): Promise<EnrichedCard[]> {
    const [lists, members, labels] = await Promise.all([
      this.#get<RawList[]>(`/boards/${boardId}/lists`, { filter: 'all', fields: 'name,closed' }, token),
      this.#get<RawMember[]>(`/boards/${boardId}/members`, { fields: 'fullName,username' }, token),
      this.#get<RawLabel[]>(`/boards/${boardId}/labels`, { fields: 'name', limit: '1000' }, token),
    ]);

    const listById = new Map(lists.map((l) => [l.id, l]));
    const archivedListIds = new Set(lists.filter((l) => l.closed).map((l) => l.id));
    const memberById = new Map(members.map((m) => [m.id, m.fullName ?? m.username ?? m.id]));
    const labelById = new Map(labels.map((l) => [l.id, l.name]));

    const cards = await this.#paginate<RawCard>(
      `/boards/${boardId}/cards`,
      {
        filter: 'visible',
        fields: 'name,desc,idList,idMembers,idLabels,due,dueComplete,url,shortUrl,dateLastActivity,closed',
      },
      token,
    );

    return cards
      .filter((c) => c.closed !== true && !archivedListIds.has(c.idList))
      .map((c) => ({
        id: c.id,
        name: c.name,
        desc: c.desc ?? '',
        listName: listById.get(c.idList)?.name ?? '',
        members: (c.idMembers ?? []).map((id) => memberById.get(id) ?? id),
        labels: (c.idLabels ?? []).flatMap((id) => {
          const name = labelById.get(id);
          return name !== undefined && name.length > 0 ? [name] : [];
        }),
        due: c.due ?? null,
        dueComplete: c.dueComplete === true,
        url: c.shortUrl ?? c.url ?? '',
        dateLastActivity: c.dateLastActivity ?? null,
      }));
  }

  /**
   * Per-column card counts for a board, in Trello's column order, including
   * empty columns. Open lists only (archived columns are not part of the
   * board's current state); cards that are closed or sit on an archived list
   * are excluded. Powers the board-breakdown skill ("state of the board").
   */
  async fetchBoardListCounts(boardId: string, token: string): Promise<{ listName: string; count: number }[]> {
    const [lists, cards] = await Promise.all([
      // filter=open returns active columns in position order.
      this.#get<RawList[]>(`/boards/${boardId}/lists`, { filter: 'open', fields: 'name' }, token),
      this.#paginate<RawCard>(`/boards/${boardId}/cards`, { filter: 'visible', fields: 'idList,closed' }, token),
    ]);
    const counts = new Map<string, number>(lists.map((l) => [l.id, 0]));
    for (const c of cards) {
      if (c.closed === true) continue;
      const cur = counts.get(c.idList);
      if (cur !== undefined) counts.set(c.idList, cur + 1);
    }
    return lists.map((l) => ({ listName: l.name, count: counts.get(l.id) ?? 0 }));
  }

  /** Single authenticated GET with 401 → auth error and 429 → backoff+retry. */
  async #get<T>(path: string, query: Record<string, string>, token: string): Promise<T> {
    const params = new URLSearchParams({ ...query, key: this.#apiKey, token });
    const url = `${TRELLO_API_BASE}${path}?${params.toString()}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const res = await this.#fetch(url);
      if (res.status === 401) {
        // Never include the URL (it carries key+token) — path + status only.
        throw new ConnectorAuthError(`Trello auth failed for ${path}`, [], { status: 401 });
      }
      if (res.status === 429) {
        if (attempt === MAX_RETRIES) {
          throw new RateLimitedError(`Trello rate limit exceeded for ${path} after ${String(MAX_RETRIES)} retries`);
        }
        const intervalMs = Number.parseInt(res.headers.get('x-rate-limit-api-token-interval-ms') ?? '', 10);
        const waitMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1000 * (attempt + 1);
        await this.#sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const body = redactString(await safeReadText(res), [token, this.#apiKey]);
        throw new ConnectorAuthError(`Trello GET ${path} failed (${String(res.status)}): ${body}`, [], {
          status: res.status,
        });
      }
      return (await res.json()) as T;
    }
    // Unreachable (loop returns or throws), but satisfies the type checker.
    throw new RateLimitedError(`Trello GET ${path} exhausted retries`);
  }

  /** Page a list endpoint via the `before=<lastId>` cursor until a short page. */
  async #paginate<T extends { id: string }>(
    path: string,
    query: Record<string, string>,
    token: string,
  ): Promise<T[]> {
    const all: T[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.#get<T[]>(
        path,
        { ...query, limit: String(PAGE_LIMIT), ...(before !== undefined ? { before } : {}) },
        token,
      );
      all.push(...page);
      if (page.length < PAGE_LIMIT) break;
      const last = page[page.length - 1];
      if (last === undefined) break;
      before = last.id;
    }
    return all;
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
