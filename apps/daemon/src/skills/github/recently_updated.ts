import type { Skill, SkillContext, SkillResult, SkillResultItem } from '../contract.js';
import type { DocRow } from './filter.js';

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const DAY_MS = 86_400_000;

/**
 * github.recently_updated — return docs updated in the last N days. Pure
 * docs-table query (no chunk-text scan); ORDER BY updated_at DESC plus
 * LIMIT keeps the result small for the synthesizer prompt.
 *
 * The classifier picks this for "what was updated this week", "recent
 * changes", "what's new since Monday".
 */
export const recentlyUpdatedSkill: Skill = {
  source: 'github',
  name: 'github.recently_updated',
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
  handler: async (args, ctx): Promise<SkillResult> => doRecent(args as RecentArgs, ctx),
};

interface RecentArgs {
  readonly days?: number;
  readonly limit?: number;
  readonly type?: string;
}

function doRecent(args: RecentArgs, ctx: SkillContext): SkillResult {
  const days = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : DEFAULT_DAYS;
  const limit = clampLimit(args.limit);
  const cutoffMs = (ctx.now?.() ?? Date.now()) - days * DAY_MS;

  const typeClause = typeof args.type === 'string' && args.type.length > 0 ? 'AND type = ?' : '';
  const sql = `SELECT id, type, title, url, updated_at
               FROM docs
               WHERE source = 'github'
                 AND updated_at >= ?
                 ${typeClause}
               ORDER BY updated_at DESC
               LIMIT ?`;
  const params: (string | number)[] =
    args.type === undefined ? [cutoffMs, limit] : [cutoffMs, args.type, limit];

  const rows = ctx.db.prepare(sql).all(...params) as DocRow[];
  const items: SkillResultItem[] = rows.map((r) => {
    const updatedDate = new Date(r.updated_at).toISOString().slice(0, 10);
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

function clampLimit(arg: number | undefined): number {
  if (typeof arg !== 'number' || !Number.isFinite(arg) || arg <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(arg));
}
