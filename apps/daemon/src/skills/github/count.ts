import type { Skill, SkillContext, SkillResult } from '../contract.js';
import { buildChunkMatch, buildDocFilter, type GithubFilter } from './filter.js';

/**
 * github_count — return the count of docs matching a filter. The filter can
 * combine type (issue / pull-request), state (open / closed), labels, and
 * author. State + labels are matched via the FTS5 phrase form against the
 * chunk text (`"Status open"`, `"Labels bug"`); type and author hit the
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
  handler: async (args, ctx): Promise<SkillResult> => doCount(args, ctx),
};

function doCount(filter: GithubFilter, ctx: SkillContext): SkillResult {
  const docFilter = buildDocFilter(filter);
  const chunkMatch = buildChunkMatch(filter);

  let sql: string;
  if (chunkMatch === null) {
    sql = `SELECT COUNT(*) AS n FROM docs WHERE ${docFilter.sql}`;
  } else {
    sql = `SELECT COUNT(DISTINCT docs.id) AS n
           FROM docs
           JOIN fts_doc_chunks ON fts_doc_chunks.doc_id = docs.id
           WHERE ${docFilter.sql} AND fts_doc_chunks MATCH ?`;
  }
  const params =
    chunkMatch === null ? [...docFilter.params] : [...docFilter.params, chunkMatch];

  const row = ctx.db.prepare(sql).get(...params) as { n: number };
  const count = row.n;

  return {
    kind: 'count',
    summary: summarize(count, filter),
    raw: { count, filter },
  };
}

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
