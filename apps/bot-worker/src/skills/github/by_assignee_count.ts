import type { Skill, SkillContext, SkillResult } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';
import { searchIssuesCount, anyToken, NO_GITHUB_SOURCE_SUMMARY } from './live-helpers.js';

const NAME = 'github_by_assignee_count';

/**
 * Counts open issues currently assigned to a person across every repo
 * the org has connected, via the GitHub Search API's exact
 * `total_count` (no first-page truncation). Resolution path is
 * try-as-login → user-search fallback.
 */
export function buildByAssigneeCountSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'Count the open GitHub issues currently assigned to a specific person. Use for "how many issues does Nathan have", "how many open issues is Jamie working on". Hits the live GitHub API.',
    inputSchema: {
      type: 'object',
      properties: {
        person: {
          type: 'string',
          description: "The person's name or GitHub login (extracted from the spoken utterance).",
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
        const count = await searchIssuesCount(
          ctx.client,
          access,
          `type:issue state:open assignee:${resolved.login}`,
        );
        return formatResult(person, resolved.login, resolved.resolved, count);
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
  count: number,
): SkillResult {
  const resolutionNote =
    via === 'search' && spoken !== login ? `Resolved "${spoken}" → "${login}". ` : '';
  const noun = count === 1 ? 'open issue' : 'open issues';
  return {
    kind: 'count',
    summary: `${resolutionNote}${login} has ${String(count)} ${noun}.`,
  };
}
