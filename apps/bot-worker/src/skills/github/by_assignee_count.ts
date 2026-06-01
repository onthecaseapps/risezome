import type { Skill, SkillResult } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';

const NAME = 'github_by_assignee_count';

/**
 * Counts open issues currently assigned to a person via the GitHub
 * Search API. Same resolution path as github_by_assignee_list
 * (try-as-login → user-search fallback) but returns an exact count
 * from the Search API's `total_count` — no first-page truncation
 * (the prior /issues?assignee= approach capped at 30).
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
      const person = String(args.person ?? '');
      try {
        const resolved = await resolvePerson(person, ctx);
        if (resolved === null) {
          return {
            kind: 'detail',
            summary: `Couldn't find a GitHub user matching "${person}".`,
          };
        }
        const q = `repo:${ctx.repo.owner}/${ctx.repo.name} type:issue state:open assignee:${resolved.login}`;
        const result = await ctx.client.getJson<{ total_count: number }>(
          ctx.auth,
          '/search/issues',
          { q, per_page: '1' },
        );
        const count = typeof result.total_count === 'number' ? result.total_count : 0;
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
