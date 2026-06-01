import type { Skill, SkillContext, SkillDbClient, SkillResult, SkillResultItem } from '@risezome/engine/skills';
import type { DocRow } from './filter.js';

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DAY_MS = 86_400_000;

/**
 * github_recently_updated — return docs updated in the last N days. Pure
 * docs-table query (no chunk-text scan); ORDER BY updated_at DESC plus
 * LIMIT keeps the result small for the synthesizer prompt.
 *
 * The classifier picks this for "what was updated this week", "recent
 * changes", "what's new since Monday".
 */
export const recentlyUpdatedSkill: Skill = {
  source: 'github',
  name: 'github_recently_updated',
  description:
    'List GitHub docs updated within the last N days, newest first. Use for "what was updated this week", "recent changes", "what is new". Default 7 days, max 25 results.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, description: 'Lookback window in days. Default 7.' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
      type: { type: 'string', enum: ['issue', 'pull-request'] },
    },
  },
  handler: async (args, ctx): Promise<SkillResult> => doRecent(args, ctx),
};

interface RecentArgs {
  readonly days?: number;
  readonly limit?: number;
  readonly type?: string;
}

async function doRecent(args: RecentArgs, ctx: SkillContext): Promise<SkillResult> {
  const days = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : DEFAULT_DAYS;
  const limit = clampLimit(args.limit);
  const nowMs = ctx.now?.() ?? Date.now();
  const cutoff = new Date(nowMs - days * DAY_MS).toISOString();

  const rows = await listRecent(ctx.db, ctx.orgId, args.type, cutoff, limit);
  const items: SkillResultItem[] = rows.map((r) => {
    const updatedDate = r.updated_at.slice(0, 10);
    const item: SkillResultItem = {
      title: r.title,
      subtitle: `updated ${updatedDate}`,
    };
    if (r.url !== null) (item as { url: string }).url = r.url;
    return item;
  });

  return {
    kind: 'list',
    summary:
      items.length === 0
        ? `No docs updated in the last ${String(days)} days.`
        : `${String(items.length)} docs updated in the last ${String(days)} days${items.length === limit ? ` (capped at ${String(limit)})` : ''}.`,
    items,
    raw: { rows, days, limit },
  };
}

async function listRecent(
  db: SkillDbClient,
  orgId: string,
  typeFilter: string | undefined,
  cutoff: string,
  limit: number,
): Promise<DocRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder = (db.from('docs') as any)
    .select('id, type, title, url, updated_at')
    .eq('org_id', orgId)
    .eq('source', 'github')
    .gte('updated_at', cutoff);
  if (typeof typeFilter === 'string' && typeFilter.length > 0) {
    builder = builder.eq('type', typeFilter);
  } else {
    builder = builder.in('type', ['issue', 'pull-request']);
  }
  builder = builder.order('updated_at', { ascending: false }).limit(limit);

  const { data, error } = (await builder) as {
    data: DocRow[] | null;
    error: unknown;
  };
  if (error !== null && error !== undefined) {
    throw new Error(`docs recently_updated failed: ${String((error as { message?: string }).message ?? error)}`);
  }
  return data ?? [];
}

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
