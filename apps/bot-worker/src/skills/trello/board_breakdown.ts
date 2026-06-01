import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { TrelloLiveContext } from './live-context.js';
import { mapTrelloError } from './error.js';
import { NO_TRELLO_SOURCE_SUMMARY } from './filter.js';

const NAME = 'trello_board_breakdown';

/**
 * Live `trello_board_breakdown` — a per-column card count for a board, in column
 * order, so a meeting can see the state of the board at a glance. The Trello
 * analog of github_issue_progress ("what's the state of the Roadmap board").
 */
export function buildTrelloBoardBreakdownSkill(ctx: TrelloLiveContext): Skill {
  return {
    source: 'trello',
    name: NAME,
    description:
      'Break a Trello board down by list/column with a card count per column, in board order. Use for "what\'s the state of the Roadmap board", "how many cards in each column", "give me the board breakdown". Hits the live Trello API. Scopes to a board by name when given; otherwise covers every connected board.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as { board?: string };
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return { kind: 'detail', summary: NO_TRELLO_SOURCE_SUMMARY };

        const boards = access.boards.filter(
          (b) => filter.board === undefined || b.name.toLowerCase().includes(filter.board.toLowerCase()),
        );
        if (boards.length === 0) {
          return { kind: 'detail', summary: `No connected Trello board matches "${filter.board ?? ''}".` };
        }

        const multiBoard = boards.length > 1;
        const items: SkillResultItem[] = [];
        const boardSummaries: string[] = [];
        for (const board of boards) {
          const counts = await ctx.client.fetchBoardListCounts(board.id, access.token);
          const total = counts.reduce((n, c) => n + c.count, 0);
          if (counts.length === 0) {
            boardSummaries.push(`${board.name} has no active columns`);
            continue;
          }
          boardSummaries.push(
            `${board.name}: ${counts.map((c) => `${c.listName} ${String(c.count)}`).join(', ')} (${String(total)} card${total === 1 ? '' : 's'})`,
          );
          for (const c of counts) {
            items.push({
              title: multiBoard ? `${board.name} › ${c.listName}` : c.listName,
              subtitle: `${String(c.count)} card${c.count === 1 ? '' : 's'}`,
            });
          }
        }

        return {
          kind: 'list',
          summary: boardSummaries.join('; ') + '.',
          items,
          raw: { board: filter.board ?? null, boards: boards.map((b) => b.name) },
        };
      } catch (err) {
        throw mapTrelloError(err, NAME);
      }
    },
  };
}
