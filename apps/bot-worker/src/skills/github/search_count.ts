import type { Skill, SkillContext, SkillResult } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import type { GithubFilter } from './filter.js';
import { summarizeCount } from './count-summary.js';
import { mapGithubError } from './error.js';
import { searchIssuesCount, NO_GITHUB_SOURCE_SUMMARY } from './live-helpers.js';

const NAME = 'github_count';

/**
 * Live `github_count` — counts matching issues/PRs via the GitHub
 * Search API. The Search API returns `total_count` in a single request
 * (per_page=1) without paginating the whole result set, so counting all
 * open issues is one API call per connected repo-group rather than the
 * full-list pagination the corpus design avoided
 * (https://github.com/orgs/community/discussions/61508).
 *
 * Counts across EVERY repo the meeting's org has connected — "how many
 * open issues do we have" reflects the whole workspace, not one repo.
 * Auth is the org's GitHub App installation token(s), resolved per call
 * from ctx.resolve(orgId); customers connect repos on the Sources page
 * and set no env vars.
 */
export function buildSearchCountSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'Count GitHub issues or pull requests matching a filter, across the workspace\'s connected repositories. Use for "how many open issues are there", "how many bugs do we have", "count PRs by jamie". Hits the live GitHub Search API for a fresh count.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Doc type to filter to: "issue" or "pull-request". Omit to count both.',
          enum: ['issue', 'pull-request'],
        },
        state: {
          type: 'string',
          description: 'Issue/PR state: "open" or "closed".',
          enum: ['open', 'closed'],
        },
        labels: {
          type: 'array',
          description: 'GitHub labels. All labels must be present (AND).',
          items: { type: 'string' },
        },
        author: {
          type: 'string',
          description: 'GitHub login of the issue/PR author.',
        },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as GithubFilter;
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) {
          return { kind: 'detail', summary: NO_GITHUB_SOURCE_SUMMARY };
        }
        const qualifiers = buildSearchQualifiers(filter);
        const count = await searchIssuesCount(ctx.client, access, qualifiers);
        return {
          kind: 'count',
          summary: summarizeCount(count, filter),
          raw: { count, qualifiers, filter },
        };
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

/**
 * Compose the GitHub Search qualifiers from the filter (everything after
 * the repo: scope, which the caller prepends per installation). Uses
 * `type:pr` (not `pull-request`) per GitHub Search vocabulary; quotes
 * labels so multi-word labels match.
 */
export function buildSearchQualifiers(filter: GithubFilter): string {
  const parts: string[] = [];
  if (filter.type === 'issue') parts.push('type:issue');
  else if (filter.type === 'pull-request') parts.push('type:pr');
  if (typeof filter.state === 'string' && filter.state.length > 0) {
    parts.push(`state:${filter.state}`);
  }
  if (filter.labels !== undefined) {
    for (const label of filter.labels) {
      if (label.length === 0) continue;
      parts.push(`label:"${label}"`);
    }
  }
  if (typeof filter.author === 'string' && filter.author.length > 0) {
    parts.push(`author:${filter.author}`);
  }
  return parts.join(' ');
}
