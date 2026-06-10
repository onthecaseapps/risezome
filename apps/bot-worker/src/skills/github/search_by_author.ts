import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import type { GithubFilter } from './filter.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';
import { buildSearchQualifiers } from './search_count.js';
import {
  searchIssuesList,
  anyToken,
  accountLogins,
  NO_GITHUB_SOURCE_RESULT,
  type GithubSearchItem,
} from './live-helpers.js';

const NAME = 'github_by_author';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Live `github_by_author` — issues/PRs authored by a person, across every
 * connected repo, via the Search API. Resolves spoken names to a GitHub login
 * (try-as-login → user-search) like the assignee skills. The Search-API twin
 * of the corpus by_author skill; "assigned to" is covered by the dedicated
 * assignee skills, so this is author-only.
 */
export function buildSearchByAuthorSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'List the GitHub issues or pull requests authored by a specific person, across the workspace\'s connected repositories. Use for "what has jamie opened", "list PRs by alice", "issues raised by nathan". Resolves spoken names to a GitHub login. Hits the live GitHub Search API. (For what a person is assigned, use the assignee skills.)',
    inputSchema: {
      type: 'object',
      required: ['login'],
      properties: {
        login: {
          type: 'string',
          description:
            'The person\'s name or GitHub login (extracted from the spoken utterance). Try-as-login first, then GitHub user search.',
        },
        type: { type: 'string', enum: ['issue', 'pull-request'] },
        state: { type: 'string', enum: ['open', 'closed'] },
        labels: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const a = args as GithubFilter & { login?: string; limit?: number };
      const spoken = String(a.login ?? '');
      const limit = clampLimit(a.limit);
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) return NO_GITHUB_SOURCE_RESULT;
        const token = anyToken(access);
        if (token === null) return NO_GITHUB_SOURCE_RESULT;
        const resolved = await resolvePerson(ctx.client, token, spoken, {
          orgs: accountLogins(access),
          signal: skillCtx.signal,
        });
        if (resolved === null) {
          return { kind: 'detail', summary: `Couldn't find a GitHub user matching "${spoken}".` };
        }
        const qualifiers = buildSearchQualifiers({ ...a, author: resolved.login });
        const { items } = await searchIssuesList(ctx.client, access, qualifiers, limit, skillCtx.signal);
        return formatByAuthor(spoken, resolved.login, resolved.resolved, items, limit);
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

function formatByAuthor(
  spoken: string,
  login: string,
  via: 'literal' | 'search',
  issues: readonly GithubSearchItem[],
  limit: number,
): SkillResult {
  const note = via === 'search' && spoken !== login ? `Resolved "${spoken}" → "${login}". ` : '';
  if (issues.length === 0) {
    return { kind: 'list', summary: `${note}${login} has authored 0 matching items.` };
  }
  const items: SkillResultItem[] = issues.map((i) => ({
    title: i.title,
    url: i.html_url,
    subtitle: `#${String(i.number)} · ${i.state}`,
  }));
  const cap = issues.length === limit ? ` (showing first ${String(limit)})` : '';
  return {
    kind: 'list',
    summary: `${note}${String(issues.length)} authored by ${login}${cap}:`,
    items,
  };
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
