import type { SkillRecovery, NeutralizedArg } from '@risezome/engine/skills';
import type { TrelloClient, EnrichedCard } from './client.js';
import type { TrelloAccess } from './source-resolver.js';

export type { NeutralizedArg };

/**
 * Shared filter grammar + card collection for the live Trello skills. Trello has
 * no server-side filtered search, so every skill fetches a board's cards (≤1000,
 * mirroring the indexer) and filters in memory here. Keeping the grammar +
 * matching in one place keeps the five skills consistent and unit-testable.
 */

export type DueStatus = 'overdue' | 'upcoming' | 'complete' | 'none' | 'any';
export const DUE_STATUSES: readonly DueStatus[] = ['overdue', 'upcoming', 'complete', 'none', 'any'];

export interface TrelloFilter {
  /** Board name to scope to (case-insensitive substring). Omit = all connected boards. */
  readonly board?: string;
  /** List/column name (case-insensitive substring). */
  readonly list?: string;
  /** Label name (case-insensitive substring). */
  readonly label?: string;
  /** Member name or username (case-insensitive substring). */
  readonly member?: string;
  /** Due-date status. */
  readonly due?: DueStatus;
  /** List-skill cap. */
  readonly limit?: number;
}

/** Shown when the meeting's org has no Trello board connected. */
export const NO_TRELLO_SOURCE_SUMMARY =
  'No Trello board is connected for this workspace yet. Connect a board on the Sources page to get live Trello answers.';

/** A card tagged with the board it came from. */
export interface CollectedCard {
  readonly card: EnrichedCard;
  readonly boardName: string;
}

/** Case-insensitive substring match (empty needle matches anything). */
function matchesText(haystack: string, needle: string | undefined): boolean {
  if (needle === undefined || needle.length === 0) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function matchesDue(card: EnrichedCard, due: DueStatus | undefined, now: number): boolean {
  if (due === undefined) return true;
  switch (due) {
    case 'none':
      return card.due === null;
    case 'any':
      return card.due !== null;
    case 'complete':
      return card.dueComplete;
    case 'overdue': {
      if (card.due === null || card.dueComplete) return false;
      const t = Date.parse(card.due);
      return Number.isFinite(t) && t < now;
    }
    case 'upcoming': {
      if (card.due === null || card.dueComplete) return false;
      const t = Date.parse(card.due);
      return Number.isFinite(t) && t >= now;
    }
    default:
      return true;
  }
}

/**
 * Fetch every connected board's cards (scoped by `filter.board` when present)
 * and tag each with its board name. Sequential to stay under Trello's per-token
 * rate limit. Board scoping happens here; list/label/member/due matching is
 * applied by `filterCards` so callers that only need the board scope (e.g. the
 * board breakdown) can skip it.
 */
export async function collectCards(
  client: TrelloClient,
  access: TrelloAccess,
  filter: Pick<TrelloFilter, 'board'>,
): Promise<CollectedCard[]> {
  const boards = access.boards.filter((b) => matchesText(b.name, filter.board));
  const out: CollectedCard[] = [];
  for (const board of boards) {
    const cards = await client.fetchEnrichedCards(board.id, access.token);
    for (const card of cards) out.push({ card, boardName: board.name });
  }
  return out;
}

/** Apply the list/label/member/due predicates (board scope already applied). */
export function filterCards(cards: readonly CollectedCard[], filter: TrelloFilter, now: number): CollectedCard[] {
  return cards.filter(
    ({ card }) =>
      matchesText(card.listName, filter.list) &&
      (filter.label === undefined || card.labels.some((l) => matchesText(l, filter.label))) &&
      (filter.member === undefined || card.members.some((m) => matchesText(m, filter.member))) &&
      matchesDue(card, filter.due, now),
  );
}

/**
 * Substring-aware domain membership (plan KTD9). A value is "real" when some
 * domain value CONTAINS it case-insensitively — mirroring `matchesText`, the
 * predicate the filter itself uses. So a spoken "Alice" is real against a
 * member named "Alice Smith" and is NOT wrongly neutralized. A value is bogus
 * only when no domain value contains it.
 */
function existsInDomain(domain: readonly string[], needle: string): boolean {
  const n = needle.trim().toLowerCase();
  // A whitespace-only needle isn't a real filter — don't neutralize it (and
  // don't let the untrimmed `includes` divergence from matchesText bite).
  if (n.length === 0) return true;
  return domain.some((v) => v.toLowerCase().includes(n));
}

/** Honest caveat from the neutralized Trello args. */
export function buildTrelloNote(neutralized: readonly NeutralizedArg[]): string {
  const phrases = neutralized.map((n) => {
    switch (n.arg) {
      case 'board':
        return `no Trello board matching '${n.value}'`;
      case 'list':
        return `no list named '${n.value}'`;
      case 'label':
        return `no label '${n.value}'`;
      case 'member':
        return `no member matching '${n.value}'`;
      default:
        return `no '${n.value}'`;
    }
  });
  const joined =
    phrases.length === 1
      ? phrases[0]!
      : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]!}`;
  const filterWord = neutralized.length > 1 ? 'those filters' : 'that filter';
  return `There's ${joined}; ignoring ${filterWord}.`;
}

export interface HealedFilterResult {
  readonly matched: CollectedCard[];
  /** The filter after neutralizing any bogus args — drives the summary. */
  readonly cleaned: TrelloFilter;
  readonly recovery?: SkillRecovery;
}

/**
 * Self-healing collect+filter (plan U3). Validates the free-text args against
 * the live board domain, neutralizes bogus values, and returns the matched
 * cards alongside a recovery signal:
 *  - `board` validates against `access.boards` BEFORE collecting — a bogus
 *    board would otherwise yield an empty card universe that makes every other
 *    arg look bogus. A bogus board is dropped and the scope widens to all
 *    boards (re-collect).
 *  - `list`/`label`/`member` validate against the real names materialized on
 *    the collected cards — zero extra API calls.
 *  - KTD8: if a real scope survives → `'repaired'`; if neutralizing left the
 *    query fully unscoped → `'unresolved'` (router drops to RAG).
 * Validation only runs for args that are present, so the common path is
 * unchanged (no recovery, same matched cards as before).
 */
export async function collectFilterHealed(
  client: TrelloClient,
  access: TrelloAccess,
  filter: TrelloFilter,
  now: number,
): Promise<HealedFilterResult> {
  const neutralized: NeutralizedArg[] = [];
  let cleaned: TrelloFilter = filter;

  if (cleaned.board !== undefined && cleaned.board.length > 0) {
    if (!existsInDomain(access.boards.map((b) => b.name), cleaned.board)) {
      neutralized.push({ arg: 'board', value: cleaned.board });
      const { board: _dropped, ...rest } = cleaned;
      cleaned = rest;
    }
  }

  const collected = await collectCards(client, access, cleaned);

  if (
    cleaned.list !== undefined &&
    cleaned.list.length > 0 &&
    !existsInDomain(
      collected.map((c) => c.card.listName),
      cleaned.list,
    )
  ) {
    neutralized.push({ arg: 'list', value: cleaned.list });
    const { list: _dropped, ...rest } = cleaned;
    cleaned = rest;
  }
  if (
    cleaned.label !== undefined &&
    cleaned.label.length > 0 &&
    !existsInDomain(
      collected.flatMap((c) => c.card.labels),
      cleaned.label,
    )
  ) {
    neutralized.push({ arg: 'label', value: cleaned.label });
    const { label: _dropped, ...rest } = cleaned;
    cleaned = rest;
  }
  if (
    cleaned.member !== undefined &&
    cleaned.member.length > 0 &&
    !existsInDomain(
      collected.flatMap((c) => c.card.members),
      cleaned.member,
    )
  ) {
    neutralized.push({ arg: 'member', value: cleaned.member });
    const { member: _dropped, ...rest } = cleaned;
    cleaned = rest;
  }

  const matched = filterCards(collected, cleaned, now);
  if (neutralized.length === 0) return { matched, cleaned };

  const stillScoped =
    cleaned.board !== undefined ||
    cleaned.list !== undefined ||
    cleaned.label !== undefined ||
    cleaned.member !== undefined ||
    cleaned.due !== undefined;
  return {
    matched,
    cleaned,
    recovery: {
      status: stillScoped ? 'repaired' : 'unresolved',
      neutralized,
      note: buildTrelloNote(neutralized),
    },
  };
}

/** Human description of the active filter, e.g. "in Doing labeled bug" — for summaries. */
export function describeFilter(filter: TrelloFilter): string {
  const parts: string[] = [];
  if (filter.board !== undefined) parts.push(`on ${filter.board}`);
  if (filter.list !== undefined) parts.push(`in ${filter.list}`);
  if (filter.label !== undefined) parts.push(`labeled ${filter.label}`);
  if (filter.member !== undefined) parts.push(`assigned to ${filter.member}`);
  if (filter.due === 'overdue') parts.push('overdue');
  else if (filter.due === 'upcoming') parts.push('due soon');
  else if (filter.due === 'complete') parts.push('marked due-complete');
  else if (filter.due === 'none') parts.push('with no due date');
  else if (filter.due === 'any') parts.push('with a due date');
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
