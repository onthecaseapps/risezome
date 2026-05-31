import type { SkillContext, SkillDbClient } from '@risezome/engine/skills';

/**
 * Mock SupabaseClient subset that records the PostgREST chain calls
 * and returns canned data. Lets the corpus-skill tests assert against
 * the chain shape without standing up a real Postgres test fixture.
 */
export interface MockDbOptions {
  readonly ftsDocIds?: readonly string[];
  readonly docsCount?: number;
  readonly docRows?: readonly {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly url: string | null;
    readonly updated_at: string;
  }[];
}

export interface RecordedCall {
  readonly table: string;
  readonly chain: ReadonlyArray<readonly [string, unknown]>;
}

export function makeMockDb(opts: MockDbOptions): {
  db: SkillDbClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

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
          count: opts.docsCount ?? null,
          data: opts.docRows ?? null,
          error: null,
        }));
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc() {
      throw new Error('rpc not used by corpus skills');
    },
  };

  return { db, calls };
}

export function ctxWith(db: SkillDbClient, overrides: Partial<SkillContext> = {}): SkillContext {
  return { db, orgId: 'org_test', ...overrides };
}
