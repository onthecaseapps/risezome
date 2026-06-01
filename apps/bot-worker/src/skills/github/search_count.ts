import type { Skill, SkillResult } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import type { GithubFilter } from './filter.js';
import { summarizeCount } from './count-summary.js';
import { mapGithubError } from './error.js';

const NAME = 'github_count';

/**
 * Live `github_count` — counts matching issues/PRs via the GitHub
 * Search API instead of the indexed corpus. The Search API returns
 * `total_count` in a single request (per_page=1) without paginating
 * the whole result set, so counting all open issues is one API call
 * rather than the full-list pagination the corpus design was built to
 * avoid (see https://github.com/orgs/community/discussions/61508).
 *
 * Always fresh, counts against the token's Search rate limit (30
 * req/min authenticated — ample for meeting cadence). Registered in
 * place of the corpus count skill when GITHUB_TOKEN +
 * RISEZOME_GITHUB_REPO are configured.
 *
 * Summary wording is shared with the corpus count via summarizeCount
 * so both produce byte-identical output the synthesizer is tuned on.
 */
export function buildSearchCountSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'Count GitHub issues or pull requests matching a filter. Use for "how many open issues are there", "how many bugs do we have", "count PRs by jamie". Hits the live GitHub Search API for a fresh count.',
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
    handler: async (args): Promise<SkillResult> => {
      const filter = args as GithubFilter;
      try {
        const q = buildSearchQuery(ctx.repo, filter);
        const result = await ctx.client.getJson<{ total_count: number }>(
          ctx.auth,
          '/search/issues',
          { q, per_page: '1' },
        );
        const count = typeof result.total_count === 'number' ? result.total_count : 0;
        return {
          kind: 'count',
          summary: summarizeCount(count, filter),
          raw: { count, q, filter },
        };
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

/**
 * Compose the GitHub Search query string from the filter. The Search
 * API uses `type:pr` (not `pull-request`) and space-separated
 * qualifiers that AND together.
 */
export function buildSearchQuery(
  repo: { readonly owner: string; readonly name: string },
  filter: GithubFilter,
): string {
  const parts: string[] = [`repo:${repo.owner}/${repo.name}`];
  if (filter.type === 'issue') parts.push('type:issue');
  else if (filter.type === 'pull-request') parts.push('type:pr');
  if (typeof filter.state === 'string' && filter.state.length > 0) {
    parts.push(`state:${filter.state}`);
  }
  if (filter.labels !== undefined) {
    for (const label of filter.labels) {
      if (label.length === 0) continue;
      // Quote labels so multi-word labels (e.g. "good first issue") match.
      parts.push(`label:"${label}"`);
    }
  }
  if (typeof filter.author === 'string' && filter.author.length > 0) {
    parts.push(`author:${filter.author}`);
  }
  return parts.join(' ');
}
