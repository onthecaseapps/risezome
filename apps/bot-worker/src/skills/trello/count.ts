import type { Skill, SkillContext, SkillResult } from '@risezome/engine/skills';
import type { TrelloLiveContext } from './live-context.js';
import { mapTrelloError } from './error.js';
import {
  collectFilterHealed,
  describeFilter,
  NO_TRELLO_SOURCE_SUMMARY,
  DUE_STATUSES,
  type TrelloFilter,
} from './filter.js';

const NAME = 'trello_count';

/**
 * Live `trello_count` — how many Trello cards match a filter (board, list/
 * column, label, member, due status) across the workspace's connected boards.
 * Trello has no server-side count, so it fetches each board's non-archived
 * cards and counts in memory.
 */
export function buildTrelloCountSkill(ctx: TrelloLiveContext): Skill {
  return {
    source: 'trello',
    name: NAME,
    description:
      'Count Trello cards matching a filter (board, list/column, label, member, due status) across the workspace\'s connected boards. Use for "how many cards are in Doing", "how many cards does Alice have", "count overdue cards". Hits the live Trello API.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        list: { type: 'string' },
        label: { type: 'string' },
        member: { type: 'string' },
        due: { type: 'string', enum: DUE_STATUSES },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as TrelloFilter;
      const now = skillCtx.now?.() ?? Date.now();
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return { kind: 'detail', summary: NO_TRELLO_SOURCE_SUMMARY };
        const { matched, cleaned, recovery } = await collectFilterHealed(
          ctx.client,
          access,
          filter,
          now,
        );
        const n = matched.length;
        return {
          kind: 'count',
          // Describe the CLEANED filter so the summary doesn't claim a scope
          // ("assigned to Jraffe") that was neutralized; the caveat rides in
          // `recovery.note`.
          summary: `${String(n)} card${n === 1 ? '' : 's'}${describeFilter(cleaned)}.`,
          raw: { count: n, filter: cleaned },
          ...(recovery !== undefined && { recovery }),
        };
      } catch (err) {
        throw mapTrelloError(err, NAME);
      }
    },
  };
}
