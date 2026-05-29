import type { Skill, SkillContext, SkillResult, SkillResultItem } from '../contract.js';
import {
  buildChunkMatch,
  buildDocFilter,
  type DocRow,
  type GithubFilter,
} from './filter.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * github_by_author — list docs by a specific GitHub login. Combines the
 * docs.authors JSON-array LIKE match with the optional state/labels filters
 * (which need FTS5). The classifier picks this for "what's jamie working
 * on", "list all PRs by jamie", "who has open bugs assigned".
 *
 * Note: docs.authors stores both `user.login` and assignee logins in one
 * JSON array (per the github connector), so this matches either author or
 * assignee transparently.
 */
export const byAuthorSkill: Skill = {
  source: 'github',
  name: 'github_by_author',
  description:
    'List GitHub docs authored by or assigned to a specific login. Use for "what is jamie working on", "list all PRs by jamie", "open bugs by alice". Combines with optional state/labels/type filters.',
  inputSchema: {
    type: 'object',
    required: ['login'],
    properties: {
      login: { type: 'string', description: 'GitHub login.' },
      type: { type: 'string', enum: ['issue', 'pull-request'] },
      state: { type: 'string', enum: ['open', 'closed'] },
      labels: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    },
  },
  handler: async (args, ctx): Promise<SkillResult> => doByAuthor(args as unknown as ByAuthorArgs, ctx),
};

interface ByAuthorArgs extends GithubFilter {
  readonly login: string;
  readonly limit?: number;
}

function doByAuthor(args: ByAuthorArgs, ctx: SkillContext): SkillResult {
  const limit = clampLimit(args.limit);
  const docFilter = buildDocFilter({ ...args, author: args.login });
  const chunkMatch = buildChunkMatch(args);

  let sql: string;
  if (chunkMatch === null) {
    sql = `SELECT id, type, title, url, updated_at
           FROM docs
           WHERE ${docFilter.sql}
           ORDER BY updated_at DESC
           LIMIT ?`;
  } else {
    sql = `SELECT docs.id, docs.type, docs.title, docs.url, docs.updated_at
           FROM docs
           JOIN fts_doc_chunks ON fts_doc_chunks.doc_id = docs.id
           WHERE ${docFilter.sql} AND fts_doc_chunks MATCH ?
           GROUP BY docs.id
           ORDER BY docs.updated_at DESC
           LIMIT ?`;
  }
  const params =
    chunkMatch === null
      ? [...docFilter.params, limit]
      : [...docFilter.params, chunkMatch, limit];

  const rows = ctx.db.prepare(sql).all(...params) as DocRow[];
  const items: SkillResultItem[] = rows.map((r) => {
    const item: SkillResultItem = { title: r.title, subtitle: r.type };
    if (r.url !== null) (item as { url: string }).url = r.url;
    return item;
  });

  return {
    kind: 'list',
    summary:
      items.length === 0
        ? `No docs found for ${args.login}.`
        : `${String(items.length)} docs by ${args.login}${args.state !== undefined ? ` (${args.state})` : ''}.`,
    items,
    raw: { rows, login: args.login, limit, filter: args },
  };
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
