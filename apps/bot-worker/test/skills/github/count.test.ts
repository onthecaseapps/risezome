import { describe, expect, it } from 'vitest';
import { countSkill } from '../../../src/skills/github/count.js';
import type { SkillContext, SkillDbClient } from '@risezome/engine/skills';

/**
 * Mock SupabaseClient subset that records the filter chain calls and
 * returns canned data. Captures the actual PostgREST builder shape the
 * skill produces so we can assert against it without standing up a
 * real Postgres test instance.
 *
 * Snapshot-based testing (per the plan's U6 execution note): the
 * canned data + the skill's summary string output are byte-equal to
 * the daemon's count.ts behavior on equivalent inputs.
 */
function makeMockDb(opts: {
  ftsDocIds?: string[];
  docsCount: number;
}): { db: SkillDbClient; calls: Array<{ table: string; chain: Array<[string, unknown]> }> } {
  const calls: Array<{ table: string; chain: Array<[string, unknown]> }> = [];

  function makeBuilder(table: string, terminal: () => Promise<unknown>) {
    const chain: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'in', 'contains', 'order', 'limit', 'gte', 'textSearch'];
    for (const m of methods) {
      builder[m] = (...args: unknown[]) => {
        chain.push([m, args]);
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      calls.push({ table, chain });
      return terminal().then(resolve, reject);
    };
    return builder;
  }

  const db: SkillDbClient = {
    from(table: string) {
      if (table === 'doc_chunks') {
        return makeBuilder(table, async () => ({
          data: (opts.ftsDocIds ?? []).map((id) => ({ doc_id: id })),
          error: null,
        }));
      }
      if (table === 'docs') {
        return makeBuilder(table, async () => ({
          count: opts.docsCount,
          data: null,
          error: null,
        }));
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc() {
      throw new Error('rpc not used by count.ts');
    },
  };

  return { db, calls };
}

function ctxWith(db: SkillDbClient): SkillContext {
  return { db, orgId: 'org_test' };
}

describe('countSkill', () => {
  it('describes itself as github_count with the load-bearing description', () => {
    expect(countSkill.name).toBe('github_count');
    expect(countSkill.source).toBe('github');
    expect(countSkill.description).toContain('Count GitHub docs');
  });

  it('zero results returns the daemon-verbatim "No matching issues." summary', async () => {
    const { db } = makeMockDb({ docsCount: 0 });
    const result = await countSkill.handler({ type: 'issue', state: 'open' }, ctxWith(db));
    expect(result.kind).toBe('count');
    expect(result.summary).toBe('No matching issues.');
  });

  it('one result uses singular noun ("1 open issue.")', async () => {
    const { db } = makeMockDb({ ftsDocIds: ['gh:x/y#issue:1'], docsCount: 1 });
    const result = await countSkill.handler({ type: 'issue', state: 'open' }, ctxWith(db));
    expect(result.summary).toBe('1 open issue.');
  });

  it('multiple results use plural noun ("5 open issues.")', async () => {
    const { db } = makeMockDb({ ftsDocIds: Array.from({ length: 5 }, (_, i) => `gh:x/y#issue:${String(i + 1)}`), docsCount: 5 });
    const result = await countSkill.handler({ type: 'issue', state: 'open' }, ctxWith(db));
    expect(result.summary).toBe('5 open issues.');
  });

  it('renders labels in single quotes joined by "and"', async () => {
    const { db } = makeMockDb({ ftsDocIds: ['a', 'b'], docsCount: 2 });
    const result = await countSkill.handler(
      { type: 'issue', state: 'open', labels: ['bug', 'phase-2'] },
      ctxWith(db),
    );
    expect(result.summary).toBe("2 open issues labeled 'bug' and 'phase-2'.");
  });

  it('renders author as " by {login}"', async () => {
    const { db } = makeMockDb({ docsCount: 3 });
    const result = await countSkill.handler(
      { type: 'issue', author: 'jamie' },
      ctxWith(db),
    );
    expect(result.summary).toBe('3 issues by jamie.');
  });

  it('omits type when no type filter (returns "5 docs.")', async () => {
    const { db } = makeMockDb({ docsCount: 5 });
    const result = await countSkill.handler({}, ctxWith(db));
    expect(result.summary).toBe('5 docs.');
  });

  it('uses "pull requests" / "pull request" for type=pull-request', async () => {
    const { db: db5 } = makeMockDb({ docsCount: 5 });
    const r5 = await countSkill.handler({ type: 'pull-request' }, ctxWith(db5));
    expect(r5.summary).toBe('5 pull requests.');

    const { db: db1 } = makeMockDb({ docsCount: 1 });
    const r1 = await countSkill.handler({ type: 'pull-request' }, ctxWith(db1));
    expect(r1.summary).toBe('1 pull request.');
  });

  it('returns 0 short-circuited when chunk-FTS lookup returns no doc_ids', async () => {
    const { db, calls } = makeMockDb({ ftsDocIds: [], docsCount: 999 });
    const result = await countSkill.handler({ type: 'issue', state: 'open' }, ctxWith(db));
    expect(result.summary).toBe('No matching issues.');
    // doc_chunks was queried, docs was NOT.
    expect(calls.find((c) => c.table === 'docs')).toBeUndefined();
  });

  it('does not query doc_chunks when no FTS filter is present', async () => {
    const { db, calls } = makeMockDb({ docsCount: 7 });
    await countSkill.handler({ type: 'issue', author: 'jamie' }, ctxWith(db));
    expect(calls.find((c) => c.table === 'doc_chunks')).toBeUndefined();
    expect(calls.find((c) => c.table === 'docs')).toBeDefined();
  });

  it('scopes docs query by org_id and source=github', async () => {
    const { db, calls } = makeMockDb({ docsCount: 1 });
    await countSkill.handler({ type: 'issue' }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const eqs = docsCall.chain.filter(([m]) => m === 'eq').map(([, args]) => args as unknown[]);
    expect(eqs).toContainEqual(['org_id', 'org_test']);
    expect(eqs).toContainEqual(['source', 'github']);
    expect(eqs).toContainEqual(['type', 'issue']);
  });

  it('filters docs.authors via contains([login]) when author is set', async () => {
    const { db, calls } = makeMockDb({ docsCount: 2 });
    await countSkill.handler({ author: 'jamie' }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const containsCalls = docsCall.chain.filter(([m]) => m === 'contains').map(([, args]) => args as unknown[]);
    expect(containsCalls).toContainEqual(['authors', ['jamie']]);
  });

  it('chains chunk FTS results through .in("id", docIds) on the docs query', async () => {
    const { db, calls } = makeMockDb({
      ftsDocIds: ['gh:x/y#issue:1', 'gh:x/y#issue:2'],
      docsCount: 2,
    });
    await countSkill.handler({ state: 'open' }, ctxWith(db));
    const docsCall = calls.find((c) => c.table === 'docs')!;
    const inCalls = docsCall.chain.filter(([m]) => m === 'in').map(([, args]) => args as unknown[]);
    expect(inCalls.find((args) => args[0] === 'id')).toEqual([
      'id',
      ['gh:x/y#issue:1', 'gh:x/y#issue:2'],
    ]);
  });
});
