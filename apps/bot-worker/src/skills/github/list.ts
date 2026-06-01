import type { Skill, SkillContext, SkillDbClient, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import {
  ftsPhraseQuery,
  lookupChunkMatchDocIds,
  type DocRow,
  type GithubFilter,
} from './filter.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * github_list — return up to `limit` docs matching a filter. Same filter
 * semantics as github_count plus a configurable limit (capped at 25 so a
 * runaway classifier args doesn't surface a thousand rows into the
 * synthesizer's prompt).
 *
 * The classifier picks this for "list all open issues", "show all PRs by
 * jamie", "what bugs are open right now".
 */
export const listSkill: Skill = {
  source: 'github',
  name: 'github_list',
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
  handler: async (args, ctx): Promise<SkillResult> => doList(args, ctx),
};

interface ListArgs extends GithubFilter {
  readonly limit?: number;
}

async function doList(args: ListArgs, ctx: SkillContext): Promise<SkillResult> {
  const limit = clampLimit(args.limit);
  const rows = await listMatching(ctx.db, ctx.orgId, args, limit);
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

async function listMatching(
  db: SkillDbClient,
  orgId: string,
  filter: GithubFilter,
  limit: number,
): Promise<DocRow[]> {
  const phrase = ftsPhraseQuery(filter);
  let matchingDocIds: string[] | null = null;
  if (phrase !== null) {
    matchingDocIds = await lookupChunkMatchDocIds(db, orgId, phrase);
    if (matchingDocIds.length === 0) return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder = (db.from('docs') as any)
    .select('id, type, title, url, updated_at')
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
  builder = builder.order('updated_at', { ascending: false }).limit(limit);

  const { data, error } = (await builder) as {
    data: DocRow[] | null;
    error: unknown;
  };
  if (error !== null && error !== undefined) {
    throw new Error(`docs list failed: ${String((error as { message?: string }).message ?? error)}`);
  }
  return data ?? [];
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
