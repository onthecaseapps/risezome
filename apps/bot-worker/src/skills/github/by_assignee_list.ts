import type { Skill, SkillContext, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';
import {
  searchIssuesList,
  anyToken,
  NO_GITHUB_SOURCE_SUMMARY,
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
          return { kind: 'detail', summary: NO_GITHUB_SOURCE_SUMMARY };
        }
        const token = anyToken(access);
        if (token === null) {
          return { kind: 'detail', summary: NO_GITHUB_SOURCE_SUMMARY };
        }
        const resolved = await resolvePerson(ctx.client, token, person);
        if (resolved === null) {
          return {
            kind: 'detail',
            summary: `Couldn't find a GitHub user matching "${person}".`,
          };
        }
        const items = await searchIssuesList(
          ctx.client,
          access,
          `type:issue state:open assignee:${resolved.login}`,
          LIMIT,
        );
        return formatResult(person, resolved.login, resolved.resolved, items);
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
): SkillResult {
  const resolutionNote =
    via === 'search' && spoken !== login ? `Resolved "${spoken}" → "${login}". ` : '';
  const count = issues.length;
  if (count === 0) {
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
  // The Search API caps results; if we hit the limit there may be more.
  const truncationNote = count === LIMIT ? ` (showing first ${String(LIMIT)})` : '';
  return {
    kind: 'list',
    summary: `${resolutionNote}${login} has ${String(count)} open issues${truncationNote}:`,
    items,
  };
}
