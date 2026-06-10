import type { Skill, SkillContext, SkillResult, SkillRecovery } from '@risezome/engine/skills';
import type { TrelloLiveContext } from './live-context.js';
import { mapTrelloError } from './error.js';
import { cardItem } from './format.js';
import {
  collectFilterHealed,
  describeFilter,
  NO_TRELLO_SOURCE_RESULT,
  DUE_STATUSES,
  type TrelloFilter,
  type CollectedCard,
} from './filter.js';

const NAME = 'trello_list';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Live `trello_list` — lists the Trello cards matching a filter (board, list/
 * column, label, member, due), up to a limit. Same grammar as trello_count, but
 * returns the cards rather than a tally.
 */
export function buildTrelloListSkill(ctx: TrelloLiveContext): Skill {
  return {
    source: 'trello',
    name: NAME,
    description:
      'List Trello cards matching a filter (board, list/column, label, member, due status), up to a limit (default 10, max 25), across the workspace\'s connected boards. Use for "list the cards in Backlog", "show cards labeled bug", "what cards are overdue". Hits the live Trello API.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        list: { type: 'string' },
        label: { type: 'string' },
        member: { type: 'string' },
        due: { type: 'string', enum: DUE_STATUSES },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as TrelloFilter & { limit?: number };
      const limit = clampLimit(filter.limit);
      const now = skillCtx.now?.() ?? Date.now();
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return NO_TRELLO_SOURCE_RESULT;
        const { matched, cleaned, recovery } = await collectFilterHealed(
          ctx.client,
          access,
          filter,
          now,
          skillCtx.signal,
        );
        const desc = describeFilter(cleaned);
        return formatCardList(
          matched,
          limit,
          {
            empty: `No matching Trello cards${desc}.`,
            summary: (total, cap) => `${String(total)} matching card${total === 1 ? '' : 's'}${desc}${cap}:`,
          },
          { count: matched.length, filter: cleaned, limit },
          recovery,
        );
      } catch (err) {
        throw mapTrelloError(err, NAME);
      }
    },
  };
}

/** Shared list framing used by trello_list, trello_by_member, trello_recently_active. */
export function formatCardList(
  matched: readonly CollectedCard[],
  limit: number,
  opts: { empty: string; summary: (total: number, cap: string) => string },
  raw: unknown,
  recovery?: SkillRecovery,
): SkillResult {
  const total = matched.length;
  if (total === 0) return { kind: 'list', summary: opts.empty, ...(recovery !== undefined && { recovery }) };
  const shown = matched.slice(0, limit);
  const cap = total > limit ? ` (showing first ${String(limit)} of ${String(total)})` : '';
  return {
    kind: 'list',
    summary: opts.summary(total, cap),
    items: shown.map(cardItem),
    raw,
    ...(recovery !== undefined && { recovery }),
  };
}

export function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
