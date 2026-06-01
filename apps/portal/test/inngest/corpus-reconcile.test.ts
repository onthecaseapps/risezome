import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  reconcile,
  clearDocChunks,
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

  it('delta mode never prunes', async () => {
    const mock = makeMockDb([
      { id: 'a', type: 'file', content_hash: 'h1' },
      { id: 'c', type: 'file', content_hash: 'h3' },
    ]);
    const res = await run(mock, desired([['a', 'h1'], ['d', 'h4']]), { mode: 'delta' });
    expect(res.counts).toMatchObject({ new: 1, unchanged: 1, removed: 0 });
    expect(mock.deletedIds()).toEqual([]);
    expect(res.pruned).toBe(false);
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
    await clearDocChunks(mock.db, 'gh:o/r#issue:7');
    expect(mock.chunkDeletes()).toEqual(['gh:o/r#issue:7']);
  });
});
