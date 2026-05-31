import type { Skill, SkillContext, SkillDbClient, SkillResult } from '@risezome/engine/skills';
import { ftsPhraseQuery, lookupChunkMatchDocIds, type GithubFilter } from './filter.js';

/**
 * github_count — return the count of docs matching a filter. The filter can
 * combine type (issue / pull-request), state (open / closed), labels, and
 * author. State + labels are matched via Postgres FTS (websearch_to_tsquery
 * against the `text_fts` column of doc_chunks); type + author hit the
 * docs table directly.
 *
 * The classifier picks this skill for utterances like "how many open issues",
 * "how many bugs are there", "count PRs by jamie".
 */
export const countSkill: Skill = {
  source: 'github',
  name: 'github_count',
  description:
    'Count GitHub docs matching a filter. Use for questions like "how many open issues are there" or "count PRs by jamie". Returns a number plus the matching doc identifiers when small.',
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
        description: 'GitHub login (author or assignee).',
      },
    },
  },
  handler: async (args, ctx): Promise<SkillResult> => doCount(args as GithubFilter, ctx),
};

async function doCount(filter: GithubFilter, ctx: SkillContext): Promise<SkillResult> {
  const count = await countMatching(ctx.db, ctx.orgId, filter);
  return {
    kind: 'count',
    summary: summarize(count, filter),
    raw: { count, filter },
  };
}

async function countMatching(
  db: SkillDbClient,
  orgId: string,
  filter: GithubFilter,
): Promise<number> {
  const phrase = ftsPhraseQuery(filter);

  let matchingDocIds: string[] | null = null;
  if (phrase !== null) {
    matchingDocIds = await lookupChunkMatchDocIds(db, orgId, phrase);
    if (matchingDocIds.length === 0) return 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder = (db.from('docs') as any)
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('source', 'github');
  if (typeof filter.type === 'string' && filter.type.length > 0) {
    builder = builder.eq('type', filter.type);
  } else {
    builder = builder.in('type', ['issue', 'pull-request']);
  }
  if (typeof filter.author === 'string' && filter.author.length > 0) {
    builder = builder.contains('authors', [filter.author]);
  }
  if (matchingDocIds !== null) {
    builder = builder.in('id', matchingDocIds);
  }
  const { count, error } = (await builder) as { count: number | null; error: unknown };
  if (error !== null && error !== undefined) {
    throw new Error(`docs count failed: ${String((error as { message?: string }).message ?? error)}`);
  }
  return count ?? 0;
}

// Verbatim from apps/daemon/src/skills/github/count.ts — the wording is
// load-bearing for the synthesizer's prompt-tuned behavior. Do not
// reword without updating snapshot tests in lockstep.
function summarize(count: number, filter: GithubFilter): string {
  if (count === 0) return `No matching ${docTypeLabel(filter)}.`;
  const noun = count === 1 ? docTypeNoun(filter) : docTypePlural(filter);
  const stateAdj = filter.state !== undefined ? ` ${filter.state}` : '';
  const labels =
    filter.labels !== undefined && filter.labels.length > 0
      ? ` labeled ${filter.labels.map((l) => `'${l}'`).join(' and ')}`
      : '';
  const author = filter.author !== undefined ? ` by ${filter.author}` : '';
  return `${String(count)}${stateAdj} ${noun}${labels}${author}.`;
}

function docTypeLabel(filter: GithubFilter): string {
  if (filter.type === 'issue') return 'issues';
  if (filter.type === 'pull-request') return 'pull requests';
  return 'docs';
}

function docTypeNoun(filter: GithubFilter): string {
  if (filter.type === 'issue') return 'issue';
  if (filter.type === 'pull-request') return 'pull request';
  return 'doc';
}

function docTypePlural(filter: GithubFilter): string {
  return docTypeLabel(filter);
}
