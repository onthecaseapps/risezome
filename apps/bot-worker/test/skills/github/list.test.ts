import { describe, expect, it } from 'vitest';
import { listSkill } from '../../../src/skills/github/list.js';
import { ctxWith, makeMockDb } from './_mock-db.js';

describe('listSkill', () => {
  it('describes itself as github_list', () => {
    expect(listSkill.name).toBe('github_list');
  });

  it('zero results returns the daemon-verbatim summary', async () => {
    const { db } = makeMockDb({ docRows: [] });
    const result = await listSkill.handler({ state: 'open' }, ctxWith(db));
    expect(result.summary).toBe('No matching docs.');
    expect(result.items).toEqual([]);
  });

  it('single result uses singular "doc"', async () => {
    const { db } = makeMockDb({
      ftsDocIds: ['gh:x/y#issue:1'],
      docRows: [
        { id: 'gh:x/y#issue:1', type: 'issue', title: 'Auth bug', url: 'https://github.com/x/y/issues/1', updated_at: '2026-05-30T12:00:00Z' },
      ],
    });
    const result = await listSkill.handler({ state: 'open' }, ctxWith(db));
    expect(result.summary).toBe('1 matching doc.');
    expect(result.items).toEqual([{ title: 'Auth bug', url: 'https://github.com/x/y/issues/1' }]);
  });

  it('multiple results use plural "docs"', async () => {
    const { db } = makeMockDb({
      ftsDocIds: ['a', 'b', 'c'],
      docRows: [
        { id: 'a', type: 'issue', title: 'A', url: null, updated_at: '2026-05-30T12:00:00Z' },
        { id: 'b', type: 'issue', title: 'B', url: null, updated_at: '2026-05-29T12:00:00Z' },
        { id: 'c', type: 'pull-request', title: 'C', url: null, updated_at: '2026-05-28T12:00:00Z' },
      ],
    });
    const result = await listSkill.handler({ state: 'open' }, ctxWith(db));
    expect(result.summary).toBe('3 matching docs.');
  });

  it('notes "(capped at N)" when the result count equals the limit', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `gh:x/y#issue:${String(i + 1)}`,
      type: 'issue',
      title: `Issue ${String(i + 1)}`,
      url: null,
      updated_at: '2026-05-30T12:00:00Z',
    }));
    const { db } = makeMockDb({ docRows: rows });
    const result = await listSkill.handler({ limit: 25 }, ctxWith(db));
    expect(result.summary).toBe('25 matching docs (capped at 25).');
  });

  it('orders by updated_at desc with the requested limit', async () => {
    const { db, calls } = makeMockDb({ docRows: [] });
    await listSkill.handler({ limit: 5 }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const orderCall = docsCall.chain.find(([m]) => m === 'order')!;
    expect(orderCall[1]).toEqual(['updated_at', { ascending: false }]);
    const limitCall = docsCall.chain.find(([m]) => m === 'limit')!;
    expect(limitCall[1]).toEqual([5]);
  });

  it('clamps limit > 25 to 25', async () => {
    const { db, calls } = makeMockDb({ docRows: [] });
    await listSkill.handler({ limit: 100 }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const limitCall = docsCall.chain.find(([m]) => m === 'limit')!;
    expect(limitCall[1]).toEqual([25]);
  });

  it('defaults limit to 10 when unspecified', async () => {
    const { db, calls } = makeMockDb({ docRows: [] });
    await listSkill.handler({}, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const limitCall = docsCall.chain.find(([m]) => m === 'limit')!;
    expect(limitCall[1]).toEqual([10]);
  });

  it('omits URL from items when doc has no url', async () => {
    const { db } = makeMockDb({
      docRows: [{ id: 'x', type: 'issue', title: 'No URL', url: null, updated_at: '2026-05-30T12:00:00Z' }],
    });
    const result = await listSkill.handler({}, ctxWith(db));
    expect(result.items![0]).toEqual({ title: 'No URL' });
  });
});
