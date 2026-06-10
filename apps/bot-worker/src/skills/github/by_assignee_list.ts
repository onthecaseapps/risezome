import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';
import {
  searchIssuesList,
  anyToken,
  accountLogins,
  NO_GITHUB_SOURCE_RESULT,
  type GithubSearchItem,
} from './live-helpers.js';

const NAME = 'github_by_assignee_list';
const LIMIT = 25;

/**
 * Lists open issues currently assigned to a person across every repo
 * the org has connected, via the GitHub Search API. Resolution path is
 * try-as-login → user-search fallback so spoken names that differ from
 * the GitHub login (e.g., "nathan" → "Nath5") still work.
 */
export function buildByAssigneeListSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'List the open GitHub issues currently assigned to a specific person. Use for "what issues does Nathan have", "show me Jamie\'s open issues", "what\'s on Alice\'s plate". Hits the live GitHub API for fresh data.',
    inputSchema: {
      type: 'object',
      properties: {
        person: {
          type: 'string',
          description:
            'The person\'s name or GitHub login (extracted from the spoken utterance). Try-as-login first, then GitHub user search.',
        },
      },
      required: ['person'],
    },
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const person = String(args.person ?? '');
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) {
          return NO_GITHUB_SOURCE_RESULT;
        }
        const token = anyToken(access);
        if (token === null) {
          return NO_GITHUB_SOURCE_RESULT;
        }
        const resolved = await resolvePerson(ctx.client, token, person, {
          orgs: accountLogins(access),
          signal: skillCtx.signal,
        });
        if (resolved === null) {
          return {
            kind: 'detail',
            summary: `Couldn't find a GitHub user matching "${person}".`,
          };
        }
        const { items, totalCount } = await searchIssuesList(
          ctx.client,
          access,
          `type:issue state:open assignee:${resolved.login}`,
          LIMIT,
          skillCtx.signal,
        );
        return formatResult(person, resolved.login, resolved.resolved, items, totalCount);
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

function formatResult(
  spoken: string,
  login: string,
  via: 'literal' | 'search',
  issues: readonly GithubSearchItem[],
  totalCount: number,
): SkillResult {
  const resolutionNote =
    via === 'search' && spoken !== login ? `Resolved "${spoken}" → "${login}". ` : '';
  const shown = issues.length;
  if (shown === 0) {
    return {
      kind: 'list',
      summary: `${resolutionNote}${login} has 0 open issues.`,
    };
  }
  const items: SkillResultItem[] = issues.map((issue) => ({
    title: issue.title,
    url: issue.html_url,
    subtitle: `#${String(issue.number)} · ${issue.state}`,
  }));
  // When page-capped, state the Search API's real total ("60 open issues
  // (showing first 25)") — the page length reads as the whole population.
  const total = Math.max(totalCount, shown);
  const truncationNote =
    total > shown || shown === LIMIT ? ` (showing first ${String(shown)})` : '';
  return {
    kind: 'list',
    summary: `${resolutionNote}${login} has ${String(total)} open issues${truncationNote}:`,
    items,
  };
}
