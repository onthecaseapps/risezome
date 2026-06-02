import type { Skill, SkillContext, SkillResult, SkillRecovery } from '@risezome/engine/skills';
import type { LiveSkillContext } from './live-context.js';
import type { GithubFilter } from './filter.js';
import { summarizeCount } from './count-summary.js';
import { mapGithubError } from './error.js';
import { searchIssuesCount, NO_GITHUB_SOURCE_SUMMARY, anyToken } from './live-helpers.js';
import { ConnectorAuthError, RateLimitedError } from './connector-errors.js';
import { resolvePerson, type ResolvedPerson } from './person.js';
import {
  collectRepoLabelUnion,
  partitionLabels,
  buildGithubNote,
  type NeutralizedArg,
} from './self-heal.js';

const NAME = 'github_count';

/**
 * Live `github_count` — counts matching issues/PRs via the GitHub
 * Search API. The Search API returns `total_count` in a single request
 * (per_page=1) without paginating the whole result set, so counting all
 * open issues is one API call per connected repo-group rather than the
 * full-list pagination the corpus design avoided
 * (https://github.com/orgs/community/discussions/61508).
 *
 * Counts across EVERY repo the meeting's org has connected — "how many
 * open issues do we have" reflects the whole workspace, not one repo.
 * Auth is the org's GitHub App installation token(s), resolved per call
 * from ctx.resolve(orgId); customers connect repos on the Sources page
 * and set no env vars.
 */
export function buildSearchCountSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      'Count GitHub issues or pull requests matching a filter, across the workspace\'s connected repositories. Use for "how many open issues are there", "how many bugs do we have", "count PRs by jamie". Hits the live GitHub Search API for a fresh count.',
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
    handler: async (args, skillCtx: SkillContext): Promise<SkillResult> => {
      const filter = args as GithubFilter;
      try {
        const access = await ctx.resolve(skillCtx.orgId);
        if (access === null) {
          return { kind: 'detail', summary: NO_GITHUB_SOURCE_SUMMARY };
        }

        // Self-heal free-text args against the live domain (plan U2). Only
        // fires when a risky arg is present, so safe-enum-only queries pay
        // nothing (R2). A bogus value is neutralized and surfaced honestly.
        const neutralized: NeutralizedArg[] = [];
        let cleaned: GithubFilter = filter;

        if (filter.labels?.some((l) => l.length > 0) === true) {
          try {
            const { labels: union, complete } = await collectRepoLabelUnion(ctx.client, access);
            // Only neutralize against a COMPLETE domain. If a repo's label set
            // was truncated at the page cap, an unmatched label might be real,
            // so leave the filter as-is rather than confidently dropping it.
            if (complete) {
              const { valid, bogus } = partitionLabels(filter.labels, union);
              if (bogus.length > 0) {
                const { labels: _dropped, ...rest } = cleaned;
                cleaned = valid.length > 0 ? { ...rest, labels: valid } : rest;
                for (const value of bogus) neutralized.push({ arg: 'labels', value });
              }
            }
          } catch (err) {
            // Genuine auth (401/403) and rate-limit failures are real,
            // actionable errors — let them propagate to mapGithubError
            // (skill.failed with a typed code) rather than masquerade as a
            // label misparse. The client wraps ALL non-OK statuses (incl. 5xx)
            // in ConnectorAuthError, so gate on the status, not just the type.
            const isAuth =
              err instanceof ConnectorAuthError && (err.status === 401 || err.status === 403);
            if (isAuth || err instanceof RateLimitedError) throw err;
            // Any other (transient, e.g. 5xx/network) failure: can't verify the
            // domain → don't answer on it; hand off to RAG (KTD5/KTD6).
            return {
              kind: 'count',
              summary: 'Could not verify the requested GitHub labels right now.',
              recovery: {
                status: 'unresolved',
                note: 'Could not verify the requested GitHub labels against the connected repositories.',
              },
            };
          }
        }

        if (typeof filter.author === 'string' && filter.author.length > 0) {
          const token = anyToken(access);
          let resolved: ResolvedPerson | null = null;
          try {
            resolved = token !== null ? await resolvePerson(ctx.client, token, filter.author) : null;
          } catch (err) {
            // Genuine auth/rate-limit propagate; a transient resolve failure
            // just neutralizes the author (drop it, keep any label heals)
            // instead of failing the whole skill.
            const isAuth =
              err instanceof ConnectorAuthError && (err.status === 401 || err.status === 403);
            if (isAuth || err instanceof RateLimitedError) throw err;
            resolved = null;
          }
          if (resolved === null) {
            neutralized.push({ arg: 'author', value: filter.author });
            const { author: _dropped, ...rest } = cleaned;
            cleaned = rest;
          } else if (resolved.login !== filter.author) {
            // Canonicalize to the real login (not a neutralization).
            cleaned = { ...cleaned, author: resolved.login };
          }
        }

        const qualifiers = buildSearchQualifiers(cleaned);
        const count = await searchIssuesCount(ctx.client, access, qualifiers);

        if (neutralized.length === 0) {
          return { kind: 'count', summary: summarizeCount(count, cleaned), raw: { count, qualifiers } };
        }

        // KTD8: if neutralizing left the query fully unscoped (whole-repo),
        // the broadened count would mislead — mark unresolved so the router
        // drops to RAG. Otherwise a real scope survives → repaired + caveat.
        const recovery: SkillRecovery =
          qualifiers.length === 0
            ? { status: 'unresolved', neutralized, note: buildGithubNote(neutralized) }
            : { status: 'repaired', neutralized, note: buildGithubNote(neutralized) };
        return {
          kind: 'count',
          summary: summarizeCount(count, cleaned),
          raw: { count, qualifiers, neutralized },
          recovery,
        };
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

/**
 * Compose the GitHub Search qualifiers from the filter (everything after
 * the repo: scope, which the caller prepends per installation). Uses
 * `type:pr` (not `pull-request`) per GitHub Search vocabulary; quotes
 * labels so multi-word labels match.
 */
export function buildSearchQualifiers(filter: GithubFilter): string {
  const parts: string[] = [];
  if (filter.type === 'issue') parts.push('type:issue');
  else if (filter.type === 'pull-request') parts.push('type:pr');
  if (typeof filter.state === 'string' && filter.state.length > 0) {
    parts.push(`state:${filter.state}`);
  }
  if (filter.labels !== undefined) {
    for (const label of filter.labels) {
      if (label.length === 0) continue;
      parts.push(`label:"${label}"`);
    }
  }
  if (typeof filter.author === 'string' && filter.author.length > 0) {
    parts.push(`author:${filter.author}`);
  }
  return parts.join(' ');
}
