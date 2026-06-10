import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import type { GithubFilter } from './filter.js';
import { mapGithubError } from './error.js';
import { buildSearchQualifiers } from './search_count.js';
import {
  searchIssuesList,
  NO_GITHUB_SOURCE_RESULT,
  type GithubSearchItem,
} from './live-helpers.js';

const NAME = 'github_list';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Live `github_list` — lists matching issues/PRs via the GitHub Search API
 * across every repo the meeting's org has connected. The Search-API twin of
 * the corpus list skill: same filter grammar (type/state/labels/author +
 * limit), but fresh data instead of the indexed corpus.
 */
export function buildSearchListSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'List GitHub issues or pull requests matching a filter (type, state, labels, author), up to a limit (default 10, max 25), across the workspace\'s connected repositories. Use for "list all open issues", "show all PRs by jamie", "what bugs are open". Hits the live GitHub Search API for fresh data.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['issue', 'pull-request'] },
        state: { type: 'string', enum: ['open', 'closed'] },
        labels: { type: 'array', items: { type: 'string' } },
        author: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as GithubFilter & { limit?: number };
      const limit = clampLimit(filter.limit);
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return NO_GITHUB_SOURCE_RESULT;
        const qualifiers = buildSearchQualifiers(filter);
        const { items, totalCount } = await searchIssuesList(
          ctx.client,
          access,
          qualifiers,
          limit,
          skillCtx.signal,
        );
        return formatList(items, totalCount, limit, filter);
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

function formatList(
  issues: readonly GithubSearchItem[],
  totalCount: number,
  limit: number,
  filter: GithubFilter,
): SkillResult {
  if (issues.length === 0) {
    return { kind: 'list', summary: 'No matching issues or pull requests.' };
  }
  const items: SkillResultItem[] = issues.map((i) => ({
    title: i.title,
    url: i.html_url,
    subtitle: `#${String(i.number)} · ${i.state}`,
  }));
  // When page-capped, state the Search API's real total ("47 matching items
  // (showing first 25)"), not the page length — the page length reads as the
  // whole population and is confidently wrong.
  const total = Math.max(totalCount, issues.length);
  const cap = total > issues.length || issues.length === limit ? ` (showing first ${String(issues.length)})` : '';
  return {
    kind: 'list',
    summary: `${String(total)} matching ${total === 1 ? 'item' : 'items'}${cap}:`,
    items,
    raw: { qualifiers: buildSearchQualifiers(filter), limit, totalCount, filter },
  };
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
