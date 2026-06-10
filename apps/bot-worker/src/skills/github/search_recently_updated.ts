import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import {
  searchIssuesList,
  NO_GITHUB_SOURCE_RESULT,
  type GithubSearchItem,
} from './live-helpers.js';

const NAME = 'github_recently_updated';
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DAY_MS = 86_400_000;

/**
 * Live `github_recently_updated` — issues/PRs updated within the last N days,
 * newest first, across every connected repo. Search-API twin of the corpus
 * skill: an `updated:>=<date>` qualifier instead of a docs-table window. The
 * Search helper already sorts newest-updated first.
 */
export function buildSearchRecentlyUpdatedSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'List GitHub issues or pull requests updated within the last N days, newest first, across the workspace\'s connected repositories. Use for "what was updated this week", "recent changes", "what is new". Default 7 days, max 25 results. Hits the live GitHub Search API.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          maximum: 90,
          description: 'Lookback window in days. Default 7.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        type: { type: 'string', enum: ['issue', 'pull-request'] },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const a = args as { days?: number; limit?: number; type?: string };
      const days = typeof a.days === 'number' && a.days > 0 ? Math.floor(a.days) : DEFAULT_DAYS;
      const limit = clampLimit(a.limit);
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return NO_GITHUB_SOURCE_RESULT;
        const nowMs = skillCtx.now?.() ?? Date.now();
        const cutoff = new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
        const parts = [`updated:>=${cutoff}`];
        if (a.type === 'issue') parts.push('type:issue');
        else if (a.type === 'pull-request') parts.push('type:pr');
        const { items } = await searchIssuesList(ctx.client, access, parts.join(' '), limit, skillCtx.signal);
        return formatRecent(items, days, limit);
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

function formatRecent(
  issues: readonly GithubSearchItem[],
  days: number,
  limit: number,
): SkillResult {
  if (issues.length === 0) {
    return { kind: 'list', summary: `No issues or pull requests updated in the last ${String(days)} days.` };
  }
  const items: SkillResultItem[] = issues.map((i) => ({
    title: i.title,
    url: i.html_url,
    subtitle: `updated ${i.updated_at.slice(0, 10)}`,
  }));
  const cap = issues.length === limit ? ` (showing first ${String(limit)})` : '';
  return {
    kind: 'list',
    summary: `${String(issues.length)} updated in the last ${String(days)} days${cap}:`,
    items,
  };
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
