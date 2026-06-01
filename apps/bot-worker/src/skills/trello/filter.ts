import type { TrelloClient, EnrichedCard } from './client.js';
import type { TrelloAccess } from './source-resolver.js';

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
