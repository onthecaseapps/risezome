import type { Skill, SkillContext, SkillResult } from '@risezome/engine/skills';
import type { GithubIssue } from './types.js';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';
import { authForToken, firstRepo, NO_GITHUB_SOURCE_RESULT } from './live-helpers.js';

const NAME = 'github_issue_assignees';

/**
 * Looks up the current assignees of a GitHub issue/PR by number.
 *
 * An issue number is repo-scoped, so this skill targets ONE repo. Until
 * repo-routing lands (the classifier picking the target repo from
 * meeting context) it uses the org's first connected repo. Picked by
 * the classifier for "who is issue 14 assigned to" / "who owns #42".
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
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const issueNumber = Number(args.issue_number);
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        const repo = access === null ? null : firstRepo(access);
        if (repo === null) {
          return NO_GITHUB_SOURCE_RESULT;
        }
        const issue = await ctx.client.getJson<GithubIssue>(
          authForToken(repo.token),
          `/repos/${repo.owner}/${repo.name}/issues/${String(issueNumber)}`,
          undefined,
          skillCtx.signal,
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
