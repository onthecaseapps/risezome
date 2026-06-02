import type { Skill, SkillContext, SkillResult, SkillRecovery } from '@risezome/engine/skills';
import type { TrelloLiveContext } from './live-context.js';
import { mapTrelloError } from './error.js';
import { formatCardList, clampLimit } from './list.js';
import {
  collectFilterHealed,
  NO_TRELLO_SOURCE_SUMMARY,
  type TrelloFilter,
} from './filter.js';

const NAME = 'trello_by_member';

/**
 * Live `trello_by_member` — the Trello cards a given member is assigned to,
 * optionally scoped to a board or column. The Trello analog of
 * github_by_assignee_list ("what is Alice working on").
 */
export function buildTrelloByMemberSkill(ctx: TrelloLiveContext): Skill {
  return {
    source: 'trello',
    name: NAME,
    description:
      'List the Trello cards a specific member is assigned to, optionally scoped to a board or list/column. Use for "what is Alice working on", "what\'s on Bob\'s plate in Trello", "show Jamie\'s cards". Requires a member name. Hits the live Trello API.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string' },
        board: { type: 'string' },
        list: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['member'],
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as TrelloFilter & { limit?: number };
      const member = filter.member;
      if (member === undefined || member.length === 0) {
        return { kind: 'detail', summary: 'Specify which member to look up Trello cards for.' };
      }
      const limit = clampLimit(filter.limit);
      const now = skillCtx.now?.() ?? Date.now();
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return { kind: 'detail', summary: NO_TRELLO_SOURCE_SUMMARY };
        const { matched, recovery: healed } = await collectFilterHealed(
          ctx.client,
          access,
          filter,
          now,
        );
        // by_member is fundamentally about the member; if the member itself was
        // neutralized the answer can't be about them, so force 'unresolved'
        // (drop to RAG) even if another scope survived (KTD8).
        const memberBogus = healed?.neutralized?.some((n) => n.arg === 'member') ?? false;
        const recovery: SkillRecovery | undefined =
          memberBogus && healed !== undefined ? { ...healed, status: 'unresolved' } : healed;
        return formatCardList(
          matched,
          limit,
          {
            empty: `${member} is not assigned to any Trello cards.`,
            summary: (total, cap) =>
              `${member} is assigned to ${String(total)} card${total === 1 ? '' : 's'}${cap}:`,
          },
          { member, count: matched.length, limit },
          recovery,
        );
      } catch (err) {
        throw mapTrelloError(err, NAME);
      }
    },
  };
}
