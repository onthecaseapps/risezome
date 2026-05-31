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
 * github_by_author — list docs by a specific GitHub login. Combines the
 * docs.authors jsonb contains-match with the optional state/labels filters
 * (which need FTS on chunks). The classifier picks this for "what's jamie
 * working on", "list all PRs by jamie", "who has open bugs assigned".
 *
 * Note: docs.authors stores both `user.login` and assignee logins in one
 * jsonb array (per the U5 chunker), so this matches either author or
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

async function doByAuthor(args: ByAuthorArgs, ctx: SkillContext): Promise<SkillResult> {
  const limit = clampLimit(args.limit);
  const rows = await listForAuthor(ctx.db, ctx.orgId, args, limit);
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

async function listForAuthor(
  db: SkillDbClient,
  orgId: string,
  args: ByAuthorArgs,
  limit: number,
): Promise<DocRow[]> {
  const phrase = ftsPhraseQuery(args);
  let matchingDocIds: string[] | null = null;
  if (phrase !== null) {
    matchingDocIds = await lookupChunkMatchDocIds(db, orgId, phrase);
    if (matchingDocIds.length === 0) return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder = (db.from('docs') as any)
    .select('id, type, title, url, updated_at')
    .eq('org_id', orgId)
    .eq('source', 'github')
    .contains('authors', [args.login]);
  if (typeof args.type === 'string' && args.type.length > 0) {
    builder = builder.eq('type', args.type);
  } else {
    builder = builder.in('type', ['issue', 'pull-request']);
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
    throw new Error(`docs by_author failed: ${String((error as { message?: string }).message ?? error)}`);
  }
  return data ?? [];
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
