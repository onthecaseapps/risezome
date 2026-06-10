import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  reconcile,
  clearDocChunks,
  writeReconciledDoc,
  type DesiredItem,
  type ReconcileMode,
} from '../../src/inngest/lib/corpus-reconcile';

/**
 * Mock SupabaseClient covering the two chains the helper uses:
 *   - read:   from('docs').select(...).eq('source_id',_).in('type',_).range(a,b)
 *   - delete: from('docs').delete().in('id', batch)
 *   - chunks: from('doc_chunks').delete().eq('doc_id', id)
 * Records delete batches + the type filter for assertions.
 */
function makeMockDb(existing: { id: string; type: string; content_hash: string | null }[]) {
  const deletedIdBatches: string[][] = [];
  const chunkDeletes: string[] = [];
  let readTypes: string[] | null = null;
  let readSourceId: string | null = null;

  function docsBuilder() {
    let op: 'select' | 'delete' = 'select';
    let typeFilter: string[] | null = null;
    let sourceFilter: string | null = null;
    let idBatch: string[] | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.delete = () => {
      op = 'delete';
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      if (col === 'source_id') sourceFilter = val as string;
      return b;
    };
    b.in = (col: string, vals: string[]) => {
      if (col === 'type') typeFilter = vals;
      if (col === 'id') idBatch = vals;
      return b;
    };
    b.range = async (lo: number, hi: number) => {
      readTypes = typeFilter;
      readSourceId = sourceFilter;
      const scoped = existing.filter(
        (r) => (typeFilter === null || typeFilter.includes(r.type)),
      );
      const slice = scoped.slice(lo, hi + 1);
      return { data: slice.map((r) => ({ id: r.id, content_hash: r.content_hash })), error: null };
    };
    // delete resolves when awaited via .in('id') returning a thenable
    b.then = (resolve: (v: unknown) => unknown) => {
      if (op === 'delete' && idBatch !== null) {
        deletedIdBatches.push(idBatch);
        return resolve({ error: null });
      }
      return resolve({ error: null });
    };
    return b;
  }

  function chunksBuilder() {
    let docId: string | null = null;
    const b: Record<string, unknown> = {};
    b.delete = () => b;
    b.eq = (col: string, val: unknown) => {
      if (col === 'doc_id') docId = val as string;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (docId !== null) chunkDeletes.push(docId);
      return resolve({ error: null });
    };
    return b;
  }

  const db = {
    from(table: string) {
      if (table === 'docs') return docsBuilder();
      if (table === 'doc_chunks') return chunksBuilder();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return {
    db,
    deletedIds: () => deletedIdBatches.flat(),
    deleteBatches: () => deletedIdBatches,
    chunkDeletes: () => chunkDeletes,
    readTypes: () => readTypes,
    readSourceId: () => readSourceId,
  };
}

function desired(entries: [string, string][]): Map<string, DesiredItem> {
  return new Map(entries.map(([id, hash]) => [id, { hash }]));
}

const FILE_TYPES = ['file'];
const ISSUE_TYPES = ['issue', 'pull-request'];

function run(
  mock: ReturnType<typeof makeMockDb>,
  d: Map<string, DesiredItem>,
  opts: { ownedTypes?: string[]; mode?: ReconcileMode; fetchComplete?: boolean; confirmedEmpty?: boolean } = {},
) {
  return reconcile(mock.db, {
    sourceId: 'src1',
    ownedTypes: opts.ownedTypes ?? FILE_TYPES,
    desired: d,
    mode: opts.mode ?? 'full',
    fetchComplete: opts.fetchComplete ?? true,
    ...(opts.confirmedEmpty !== undefined ? { confirmedEmpty: opts.confirmedEmpty } : {}),
  });
}

describe('reconcile — diff', () => {
  it('partitions new / changed / unchanged and prunes removed (full)', async () => {
    const mock = makeMockDb([
      { id: 'a', type: 'file', content_hash: 'h1' },
      { id: 'b', type: 'file', content_hash: 'h2' },
      { id: 'c', type: 'file', content_hash: 'h3' },
    ]);
    const res = await run(mock, desired([['a', 'h1'], ['b', 'h2x'], ['d', 'h4']]));
    expect(res.counts).toEqual({ new: 1, changed: 1, unchanged: 1, removed: 1 });
    expect(res.toIndex.find((t) => t.docId === 'd')?.kind).toBe('new');
    expect(res.toIndex.find((t) => t.docId === 'b')?.kind).toBe('changed');
    expect(res.toIndex.find((t) => t.docId === 'a')).toBeUndefined();
    expect(mock.deletedIds()).toEqual(['c']);
    expect(res.pruned).toBe(true);
  });

  it('delta mode prunes when the fetch is complete (delta-prune-on-complete-fetch)', async () => {
    // The desired set is the source's WHOLE current state (fetchComplete) —
    // pruning its absences is as safe in delta as in full, and content-
    // addressed docIds would otherwise accumulate stale versions forever.
    const mock = makeMockDb([
      { id: 'a', type: 'file', content_hash: 'h1' },
      { id: 'c', type: 'file', content_hash: 'h3' },
    ]);
    const res = await run(mock, desired([['a', 'h1'], ['d', 'h4']]), { mode: 'delta', fetchComplete: true });
    expect(res.counts).toMatchObject({ new: 1, unchanged: 1, removed: 1 });
    expect(mock.deletedIds()).toEqual(['c']);
    expect(res.pruned).toBe(true);
  });

  it('delta mode with an incremental (incomplete) fetch never prunes', async () => {
    const mock = makeMockDb([
      { id: 'a', type: 'file', content_hash: 'h1' },
      { id: 'c', type: 'file', content_hash: 'h3' },
    ]);
    const res = await run(mock, desired([['a', 'h1'], ['d', 'h4']]), { mode: 'delta', fetchComplete: false });
    expect(res.counts).toMatchObject({ new: 1, unchanged: 1, removed: 0 });
    expect(mock.deletedIds()).toEqual([]);
    expect(res.pruned).toBe(false);
  });

  it('delta mode on a complete fetch removes the superseded version of an edited file', async () => {
    // Content-addressed docIds: an edit arrives as a NEW docId; the old
    // version is only ever removed by the prune — which must therefore run
    // in delta (the default mode) too.
    const mock = makeMockDb([{ id: 'p@sha1', type: 'file', content_hash: 'p@sha1' }]);
    const res = await run(mock, desired([['p@sha2', 'p@sha2']]), { mode: 'delta', fetchComplete: true });
    expect(res.toIndex).toEqual([{ docId: 'p@sha2', kind: 'new' }]);
    expect(mock.deletedIds()).toEqual(['p@sha1']);
  });

  it('null existing hash → changed (backfill re-index)', async () => {
    const mock = makeMockDb([{ id: 'a', type: 'file', content_hash: null }]);
    const res = await run(mock, desired([['a', 'h1']]));
    expect(res.toIndex).toEqual([{ docId: 'a', kind: 'changed' }]);
  });

  it('content-addressed file shape: changed file is new docId + old pruned', async () => {
    const mock = makeMockDb([{ id: 'p@sha1', type: 'file', content_hash: 'p@sha1' }]);
    const res = await run(mock, desired([['p@sha2', 'p@sha2']]));
    expect(res.toIndex).toEqual([{ docId: 'p@sha2', kind: 'new' }]);
    expect(mock.deletedIds()).toEqual(['p@sha1']);
  });
});

describe('reconcile — R8 type scope', () => {
  it('file reconcile reads only file docs and never deletes issue docs sharing the source_id', async () => {
    const mock = makeMockDb([
      { id: 'file-a', type: 'file', content_hash: 'h1' },
      { id: 'gh:o/r#issue:1', type: 'issue', content_hash: 'hi1' },
      { id: 'gh:o/r#issue:2', type: 'pull-request', content_hash: 'hi2' },
    ]);
    // desired contains only files; a naive source_id-scoped prune would
    // delete both issue docs.
    const res = await run(mock, desired([['file-a', 'h1']]), { ownedTypes: FILE_TYPES });
    expect(mock.readTypes()).toEqual(FILE_TYPES);
    expect(mock.deletedIds()).toEqual([]); // issue docs invisible to a file reconcile
    expect(res.counts.removed).toBe(0);
  });

  it('issue reconcile reads only issue/PR docs and never deletes file docs', async () => {
    const mock = makeMockDb([
      { id: 'file-a', type: 'file', content_hash: 'h1' },
      { id: 'gh:o/r#issue:1', type: 'issue', content_hash: 'hi1' },
    ]);
    // desired empty issue set + confirmedEmpty → would prune issue docs,
    // but file-a must survive (not in the issue-scoped existing read).
    const res = await run(mock, desired([]), {
      ownedTypes: ISSUE_TYPES,
      confirmedEmpty: true,
    });
    expect(mock.readTypes()).toEqual(ISSUE_TYPES);
    expect(mock.deletedIds()).toEqual(['gh:o/r#issue:1']);
    expect(res.counts.removed).toBe(1);
  });
});

describe('reconcile — R9 prune gate', () => {
  it('full mode with fetchComplete=false indexes but does not prune', async () => {
    const mock = makeMockDb([
      { id: 'a', type: 'file', content_hash: 'h1' },
      { id: 'c', type: 'file', content_hash: 'h3' },
    ]);
    const res = await run(mock, desired([['a', 'h1'], ['d', 'h4']]), { fetchComplete: false });
    expect(res.toIndex.map((t) => t.docId)).toEqual(['d']);
    expect(mock.deletedIds()).toEqual([]);
    expect(res.pruned).toBe(false);
  });

  it('prune-to-zero is blocked unless confirmedEmpty', async () => {
    const existingRows = [
      { id: 'a', type: 'file', content_hash: 'h1' },
      { id: 'b', type: 'file', content_hash: 'h2' },
    ];
    const blocked = makeMockDb(existingRows);
    const r1 = await run(blocked, desired([]), { fetchComplete: true });
    expect(blocked.deletedIds()).toEqual([]);
    expect(r1.pruned).toBe(false);

    const allowed = makeMockDb(existingRows);
    const r2 = await run(allowed, desired([]), { fetchComplete: true, confirmedEmpty: true });
    expect(allowed.deletedIds().sort()).toEqual(['a', 'b']);
    expect(r2.counts.removed).toBe(2);
  });
});

describe('reconcile — delete batching', () => {
  it('splits large delete sets into batches', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `f${String(i)}`,
      type: 'file',
      content_hash: `h${String(i)}`,
    }));
    const mock = makeMockDb(rows);
    // desired keeps none → all 250 pruned (confirmedEmpty since desired empty)
    await reconcile(mock.db, {
      sourceId: 'src1',
      ownedTypes: FILE_TYPES,
      desired: new Map(),
      mode: 'full',
      fetchComplete: true,
      confirmedEmpty: true,
      deleteBatchSize: 100,
    });
    const batches = mock.deleteBatches();
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });
});

describe('clearDocChunks', () => {
  it('deletes chunks scoped to the docId', async () => {
    const mock = makeMockDb([]);
    await clearDocChunks(mock.db, 'gh:o/r#issue:7', 'org-1');
    expect(mock.chunkDeletes()).toEqual(['gh:o/r#issue:7']);
  });
});

describe('writeReconciledDoc — transient-failure retry', () => {
  // Build a db whose docs.upsert fails `failures` times with `message`
  // before succeeding; all other writes succeed. Records attempt counts.
  function makeFlakyDb(failures: number, message: string) {
    let upsertAttempts = 0;
    const db = {
      from(table: string) {
        if (table === 'docs') {
          return {
            upsert: async () => {
              upsertAttempts += 1;
              return upsertAttempts <= failures ? { error: { message } } : { error: null };
            },
            update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          };
        }
        return { upsert: async () => ({ error: null }) };
      },
    } as unknown as Parameters<typeof writeReconciledDoc>[0];
    return { db, attempts: () => upsertAttempts };
  }

  const write = {
    docId: 'd1',
    kind: 'new' as const,
    hash: 'h1',
    doc: {
      orgId: 'o1',
      sourceId: 's1',
      source: 'github',
      type: 'file',
      title: 't',
      url: null,
      provenance: 'trusted' as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    chunks: [{ chunkId: 'd1::0', domain: 'text', text: 'x', position: 0 }],
    embeddings: ['[0.1]'],
  };

  it('retries a Cloudflare HTML error page and succeeds', async () => {
    const flaky = makeFlakyDb(2, '<!DOCTYPE html>\n<html lang="en-US">…cloudflare…');
    await writeReconciledDoc(flaky.db, write, { retryDelaysMs: [0, 0, 0] });
    expect(flaky.attempts()).toBe(3);
  });

  it('retries thrown network failures (undici fetch failed)', async () => {
    let calls = 0;
    const db = {
      from(table: string) {
        if (table === 'docs') {
          return {
            upsert: async () => {
              calls += 1;
              if (calls === 1) throw new TypeError('fetch failed');
              return { error: null };
            },
            update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          };
        }
        return { upsert: async () => ({ error: null }) };
      },
    } as unknown as Parameters<typeof writeReconciledDoc>[0];
    await writeReconciledDoc(db, write, { retryDelaysMs: [0, 0, 0] });
    expect(calls).toBe(2);
  });

  it('does NOT retry a genuine PostgREST error (constraint violation)', async () => {
    const flaky = makeFlakyDb(99, 'duplicate key value violates unique constraint "docs_pkey"');
    await expect(
      writeReconciledDoc(flaky.db, write, { retryDelaysMs: [0, 0, 0] }),
    ).rejects.toThrow(/docs upsert failed.*duplicate key/);
    expect(flaky.attempts()).toBe(1);
  });

  it('gives up after exhausting the backoff schedule', async () => {
    const flaky = makeFlakyDb(99, '<html>Bad Gateway</html>');
    await expect(
      writeReconciledDoc(flaky.db, write, { retryDelaysMs: [0, 0] }),
    ).rejects.toThrow(/docs upsert failed/);
    expect(flaky.attempts()).toBe(3); // 1 initial + 2 retries
  });
});
