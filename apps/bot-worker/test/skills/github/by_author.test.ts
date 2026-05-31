import { describe, expect, it } from 'vitest';
import { byAuthorSkill } from '../../../src/skills/github/by_author.js';
import { ctxWith, makeMockDb } from './_mock-db.js';

describe('byAuthorSkill', () => {
  it('describes itself as github_by_author with login as required input', () => {
    expect(byAuthorSkill.name).toBe('github_by_author');
    expect(byAuthorSkill.inputSchema.required).toEqual(['login']);
  });

  it('zero results returns "No docs found for {login}."', async () => {
    const { db } = makeMockDb({ docRows: [] });
    const result = await byAuthorSkill.handler({ login: 'jamie' }, ctxWith(db));
    expect(result.summary).toBe('No docs found for jamie.');
  });

  it('with results, summary is "N docs by {login}." without state', async () => {
    const { db } = makeMockDb({
      docRows: [
        { id: 'a', type: 'issue', title: 'Issue A', url: null, updated_at: '2026-05-30T12:00:00Z' },
        { id: 'b', type: 'pull-request', title: 'PR B', url: null, updated_at: '2026-05-29T12:00:00Z' },
      ],
    });
    const result = await byAuthorSkill.handler({ login: 'jamie' }, ctxWith(db));
    expect(result.summary).toBe('2 docs by jamie.');
  });

  it('with state filter, appends "({state})" to the summary', async () => {
    const { db } = makeMockDb({
      ftsDocIds: ['a'],
      docRows: [
        { id: 'a', type: 'issue', title: 'Open thing', url: null, updated_at: '2026-05-30T12:00:00Z' },
      ],
    });
    const result = await byAuthorSkill.handler(
      { login: 'jamie', state: 'open' },
      ctxWith(db),
    );
    expect(result.summary).toBe('1 docs by jamie (open).');
  });

  it('item subtitle carries the doc type', async () => {
    const { db } = makeMockDb({
      docRows: [
        { id: 'a', type: 'issue', title: 'An issue', url: 'https://x/1', updated_at: '2026-05-30T12:00:00Z' },
      ],
    });
    const result = await byAuthorSkill.handler({ login: 'jamie' }, ctxWith(db));
    expect(result.items![0]).toEqual({
      title: 'An issue',
      subtitle: 'issue',
      url: 'https://x/1',
    });
  });

  it('always filters docs.authors via contains([login])', async () => {
    const { db, calls } = makeMockDb({ docRows: [] });
    await byAuthorSkill.handler({ login: 'jamie' }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const containsCalls = docsCall.chain.filter(([m]) => m === 'contains').map(([, args]) => args as unknown[]);
    expect(containsCalls).toContainEqual(['authors', ['jamie']]);
  });
});
