import { describe, expect, it } from 'vitest';
import { recentlyUpdatedSkill } from '../../../src/skills/github/recently_updated.js';
import { ctxWith, makeMockDb } from './_mock-db.js';

describe('recentlyUpdatedSkill', () => {
  it('describes itself as github_recently_updated', () => {
    expect(recentlyUpdatedSkill.name).toBe('github_recently_updated');
  });

  it('zero results returns "No docs updated in the last N days."', async () => {
    const { db } = makeMockDb({ docRows: [] });
    const result = await recentlyUpdatedSkill.handler({ days: 7 }, ctxWith(db));
    expect(result.summary).toBe('No docs updated in the last 7 days.');
  });

  it('with results, summary is "N docs updated in the last D days."', async () => {
    const { db } = makeMockDb({
      docRows: [
        { id: 'a', type: 'issue', title: 'A', url: null, updated_at: '2026-05-30T12:00:00Z' },
        { id: 'b', type: 'issue', title: 'B', url: null, updated_at: '2026-05-29T12:00:00Z' },
      ],
    });
    const result = await recentlyUpdatedSkill.handler({ days: 7 }, ctxWith(db));
    expect(result.summary).toBe('2 docs updated in the last 7 days.');
  });

  it('item subtitle is "updated YYYY-MM-DD"', async () => {
    const { db } = makeMockDb({
      docRows: [
        { id: 'a', type: 'issue', title: 'A', url: null, updated_at: '2026-05-30T12:34:56Z' },
      ],
    });
    const result = await recentlyUpdatedSkill.handler({ days: 7 }, ctxWith(db));
    expect(result.items![0]!.subtitle).toBe('updated 2026-05-30');
  });

  it('defaults to days=7 when not specified', async () => {
    const { db } = makeMockDb({ docRows: [] });
    const result = await recentlyUpdatedSkill.handler({}, ctxWith(db));
    expect(result.summary).toBe('No docs updated in the last 7 days.');
  });

  it('applies type filter when provided', async () => {
    const { db, calls } = makeMockDb({ docRows: [] });
    await recentlyUpdatedSkill.handler({ type: 'pull-request', days: 3 }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const eqs = docsCall.chain.filter(([m]) => m === 'eq').map(([, args]) => args as unknown[]);
    expect(eqs).toContainEqual(['type', 'pull-request']);
  });

  it('filters by updated_at >= cutoff', async () => {
    const now = Date.parse('2026-05-31T12:00:00Z');
    const { db, calls } = makeMockDb({ docRows: [] });
    await recentlyUpdatedSkill.handler({ days: 7 }, ctxWith(db, { now: () => now }));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const gteCall = docsCall.chain.find(([m]) => m === 'gte')!;
    const args = gteCall[1] as unknown[];
    expect(args[0]).toBe('updated_at');
    // 7 days before 2026-05-31T12:00:00Z is 2026-05-24T12:00:00Z
    expect(args[1]).toBe('2026-05-24T12:00:00.000Z');
  });

  it('notes "(capped at N)" when count equals limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `i${String(i)}`,
      type: 'issue',
      title: `T${String(i)}`,
      url: null,
      updated_at: '2026-05-30T12:00:00Z',
    }));
    const { db } = makeMockDb({ docRows: rows });
    const result = await recentlyUpdatedSkill.handler({ days: 7, limit: 10 }, ctxWith(db));
    expect(result.summary).toBe('10 docs updated in the last 7 days (capped at 10).');
  });
});
