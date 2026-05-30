import type { Skill, SkillResult, SkillResultItem } from '../contract.js';
import type { GithubIssue } from '../../connectors/github/types.js';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { resolvePerson } from './person.js';

const NAME = 'github_by_assignee_list';

/**
 * Lists open issues currently assigned to a person. Uses resolvePerson
 * (try-as-login then GitHub user-search fallback) so spoken names that
 * differ from the GitHub login (e.g., "nathan" → "Nath5") still work.
 *
 * First page only (30 items, GitHub default) — multi-page support is
 * deferred. The summary calls out when the resolution went through the
 * fallback path so the user sees the disambiguation.
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
        return formatResult(person, resolved.login, resolved.resolved, issues);
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
  issues: readonly GithubIssue[],
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
  // GitHub default page size is 30; if we got exactly 30 there may be more.
  const truncationNote = count === 30 ? ' (showing first 30)' : '';
  return {
    kind: 'list',
    summary: `${resolutionNote}${login} has ${String(count)} open issues${truncationNote}:`,
    items,
  };
}
