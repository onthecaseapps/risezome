import type { Skill, SkillResult } from '../contract.js';
import type { GithubIssue } from '../../connectors/github/types.js';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';

const NAME = 'github_by_assignee_count';

/**
 * Counts open issues currently assigned to a person. Same resolution
 * path as github_by_assignee_list (try-as-login → user search fallback)
 * but returns a count, not a list.
 *
 * First page only — if the user has more than 30 open issues, the
 * response truncates and the summary annotates the count as a lower
 * bound. This is acceptable for v1; pagination is deferred.
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
    handler: async (args): Promise<SkillResult> => {
      const person = String(args['person'] ?? '');
      try {
        const resolved = await resolvePerson(person, ctx);
        if (resolved === null) {
          return {
            kind: 'detail',
            summary: `Couldn't find a GitHub user matching "${person}".`,
          };
        }
        const issues = await ctx.client.getJson<readonly GithubIssue[]>(
          ctx.auth,
          `/repos/${ctx.repo.owner}/${ctx.repo.name}/issues`,
          { assignee: resolved.login, state: 'open' },
        );
        return formatResult(person, resolved.login, resolved.resolved, issues.length);
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
  // First-page truncation: if exactly 30 there may be more open issues.
  const suffix = count === 30 ? '+ open issues (first-page count).' : ' open issues.';
  return {
    kind: 'count',
    summary: `${resolutionNote}${login} has ${String(count)}${suffix}`,
  };
}
