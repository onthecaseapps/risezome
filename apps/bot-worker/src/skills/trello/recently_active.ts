import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { TrelloLiveContext } from './live-context.js';
import { mapTrelloError } from './error.js';
import { cardSubtitle } from './format.js';
import { clampLimit } from './list.js';
import {
  collectFilterHealed,
  NO_TRELLO_SOURCE_RESULT,
  type TrelloFilter,
  type CollectedCard,
} from './filter.js';

const NAME = 'trello_recently_active';

/**
 * Live `trello_recently_active` — Trello cards ordered by most recent activity
 * (newest first), optionally scoped by board/list/member. The Trello analog of
 * github_recently_updated ("what changed recently").
 */
export function buildTrelloRecentlyActiveSkill(ctx: TrelloLiveContext): Skill {
  return {
    source: 'trello',
    name: NAME,
    description:
      'List Trello cards by most recent activity (newest first), optionally scoped by board, list/column, or member, up to a limit (default 10, max 25). Use for "what changed recently in Trello", "what cards were touched this week", "most recently updated cards". Hits the live Trello API.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        list: { type: 'string' },
        member: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
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
        if (matched.length === 0) {
          return { kind: 'list', summary: 'No matching Trello cards.', ...(recovery !== undefined && { recovery }) };
        }
        const sorted = [...matched].sort((a, b) => activityTime(b) - activityTime(a));
        const shown = sorted.slice(0, limit);
        const cap = sorted.length > limit ? ` (showing ${String(limit)} most recent of ${String(sorted.length)})` : '';
        return {
          kind: 'list',
          summary: `${String(sorted.length)} recently active card${sorted.length === 1 ? '' : 's'}${cap}:`,
          items: shown.map(toRecentItem),
          raw: { count: sorted.length, filter: cleaned, limit },
          ...(recovery !== undefined && { recovery }),
        };
      } catch (err) {
        throw mapTrelloError(err, NAME);
      }
    },
  };
}

function activityTime(c: CollectedCard): number {
  if (c.card.dateLastActivity === null) return -Infinity;
  const t = Date.parse(c.card.dateLastActivity);
  return Number.isFinite(t) ? t : -Infinity;
}

function toRecentItem(c: CollectedCard): SkillResultItem {
  const base = cardSubtitle(c);
  const date = c.card.dateLastActivity !== null ? c.card.dateLastActivity.slice(0, 10) : null;
  const subtitle = [base, date !== null ? `active ${date}` : null].filter((s): s is string => s !== null).join(' · ');
  return {
    title: c.card.name,
    ...(c.card.url.length > 0 ? { url: c.card.url } : {}),
    ...(subtitle.length > 0 ? { subtitle } : {}),
  };
}
