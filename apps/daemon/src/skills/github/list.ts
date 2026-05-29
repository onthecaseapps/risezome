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
 * github.list — return up to `limit` docs matching a filter. Same filter
 * semantics as github.count plus a configurable limit (capped at 25 so a
 * runaway classifier args doesn't surface a thousand rows into the
 * synthesizer's prompt).
 *
 * The classifier picks this for "list all open issues", "show all PRs by
 * jamie", "what bugs are open right now".
 */
export const listSkill: Skill = {
  source: 'github',
  name: 'github.list',
  description:
    'List GitHub docs matching a filter, up to a limit (default 10, max 25). Use for "list all open issues", "show all PRs by jamie", etc. Returns a summary and a list of matching docs.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['issue', 'pull-request'] },
      state: { type: 'string', enum: ['open', 'closed'] },
      labels: { type: 'array', items: { type: 'string' } },
      author: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    },
  },
  handler: async (args, ctx): Promise<SkillResult> => doList(args as ListArgs, ctx),
};

interface ListArgs extends GithubFilter {
  readonly limit?: number;
}

function doList(args: ListArgs, ctx: SkillContext): SkillResult {
  const limit = clampLimit(args.limit);
  const docFilter = buildDocFilter(args);
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
    const item: SkillResultItem = { title: r.title };
    if (r.url !== null) (item as { url: string }).url = r.url;
    return item;
  });

  return {
    kind: 'list',
    summary:
      items.length === 0
        ? 'No matching docs.'
        : `${String(items.length)} matching ${items.length === 1 ? 'doc' : 'docs'}${items.length === limit ? ` (capped at ${String(limit)})` : ''}.`,
    items,
    raw: { rows, limit, filter: args },
  };
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
