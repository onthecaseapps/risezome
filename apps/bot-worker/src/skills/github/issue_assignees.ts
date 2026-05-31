import type { Skill, SkillResult } from '@risezome/engine/skills';
import type { GithubIssue } from './types.js';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';

const NAME = 'github_issue_assignees';

/**
 * Factory that returns a Skill closing over the LiveSkillContext built
 * at meeting start in serve.ts. The skill itself is a plain Skill object
 * registered alongside the corpus-backed GitHub skills.
 *
 * Picked by the classifier for utterances like "who is issue 14
 * assigned to" / "who's working on issue 7" / "who owns #42".
 */
export function buildIssueAssigneesSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'Look up the current assignees of a specific GitHub issue or pull request by number. Use for questions like "who is issue 14 assigned to" or "who\'s working on #42". Hits the live GitHub API for fresh data — does not use the indexed corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_number: {
          type: 'integer',
          minimum: 1,
          description: 'The GitHub issue or pull-request number (1-indexed).',
        },
      },
      required: ['issue_number'],
    },
    handler: async (args): Promise<SkillResult> => {
      const issueNumber = Number(args['issue_number']);
      try {
        const issue = await ctx.client.getJson<GithubIssue>(
          ctx.auth,
          `/repos/${ctx.repo.owner}/${ctx.repo.name}/issues/${issueNumber}`,
        );
        return formatResult(issue);
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

function formatResult(issue: GithubIssue): SkillResult {
  const assignees = issue.assignees ?? [];
  if (assignees.length === 0) {
    return {
      kind: 'detail',
      summary: `Issue #${String(issue.number)} ("${issue.title}") has no current assignees.`,
    };
  }
  const logins = assignees.map((a) => a.login);
  const list = logins.join(', ');
  return {
    kind: 'detail',
    summary: `Issue #${String(issue.number)} ("${issue.title}") is assigned to ${list}.`,
    items: logins.map((login) => ({
      title: login,
      url: `https://github.com/${login}`,
    })),
  };
}
