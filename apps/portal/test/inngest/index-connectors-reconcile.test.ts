import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { contentHashFromTexts } from '../../src/inngest/lib/corpus-reconcile';

/**
 * One suite for the shared connector reconcile orchestrator
 * (`runConnectorIndex`). Trello/Jira/Confluence all funnel through it, so
 * exercising it generically with a representative connector covers the
 * three: skip-unchanged, atomic re-embed of changed, full-mode prune of
 * removed, the prune gate, atomicity-on-failure, and auth handling.
 */

// ── Embedder mock: records calls; `embedImpl` lets a test force a failure.
// State lives in vi.hoisted so the (hoisted) vi.mock factory can close over
// it without a temporal-dead-zone error. ──
interface EmbedItemLike {
  readonly id: string;
  readonly text: string;
  readonly domain: string;
}
const h = vi.hoisted(() => {
  class MockRateLimitError extends Error {}
  return {
    MockRateLimitError,
    embedCalls: [] as EmbedItemLike[][],
    embedImpl: {
      fn: (items: readonly EmbedItemLike[]): { vectors: { vector: Float32Array }[] } => ({
        vectors: items.map(() => ({ vector: new Float32Array([0.1]) })),
      }),
    },
  };
});
const embedCalls = h.embedCalls;

vi.mock('@risezome/engine/embed', () => ({
  EmbeddingRateLimitError: h.MockRateLimitError,
  VoyageEmbedder: class {
    constructor(_opts: unknown) {}
    async embed(req: { items: readonly EmbedItemLike[] }) {
      h.embedCalls.push([...req.items]);
      return h.embedImpl.fn(req.items);
    }
  },
}));

// ── Supabase service-role client mock: the orchestrator + reconcile call
// createServiceRoleClient() many times; all share one in-memory corpus. ──
let currentDb: SupabaseClient;
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => currentDb,
}));

import { runConnectorIndex, type PreparedDoc } from '../../src/inngest/lib/connector-index';

interface SeedDoc {
  id: string;
  type: string;
  content_hash: string | null;
}

function makeCorpusDb(seed: SeedDoc[]) {
  const docs = new Map<string, { type: string; content_hash: string | null }>(
    seed.map((d) => [d.id, { type: d.type, content_hash: d.content_hash }]),
  );
  const chunkClears: string[] = [];
  const chunkUpserts: { docId: string; count: number }[] = [];
  const embeddingUpserts: number[] = [];
  const pruned: string[] = [];
  const sourceUpdates: Record<string, unknown>[] = [];

  function docsBuilder() {
    let op: 'select' | 'upsert' | 'update' | 'delete' = 'select';
    let payload: Record<string, unknown> | null = null;
    let typeFilter: string[] | null = null;
    let idEq: string | null = null;
    let idIn: string[] | null = null;
    const b: Record<string, unknown> = {};
    b.select = () => {
      op = 'select';
      return b;
    };
    b.upsert = (row: Record<string, unknown>) => {
      op = 'upsert';
      payload = row;
      return b;
    };
    b.update = (vals: Record<string, unknown>) => {
      op = 'update';
      payload = vals;
      return b;
    };
    b.delete = () => {
      op = 'delete';
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      if (col === 'id') idEq = val as string;
      return b;
    };
    b.in = (col: string, vals: string[]) => {
      if (col === 'type') typeFilter = vals;
      if (col === 'id') idIn = vals;
      return b;
    };
    b.range = async (lo: number, hi: number) => {
      const rows = [...docs.entries()]
        .filter(([, d]) => typeFilter === null || typeFilter.includes(d.type))
        .map(([id, d]) => ({ id, content_hash: d.content_hash }));
      return { data: rows.slice(lo, hi + 1), error: null };
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (op === 'upsert' && payload !== null) {
        docs.set(payload['id'] as string, {
          type: payload['type'] as string,
          content_hash: (payload['content_hash'] as string | null) ?? null,
        });
      } else if (op === 'update' && idEq !== null && payload !== null) {
        const d = docs.get(idEq);
        if (d !== undefined) d.content_hash = (payload['content_hash'] as string | null) ?? null;
      } else if (op === 'delete' && idIn !== null) {
        for (const id of idIn) {
          docs.delete(id);
          pruned.push(id);
        }
      }
      return resolve({ error: null });
    };
    return b;
  }

  function chunksBuilder() {
    let op: 'upsert' | 'delete' = 'upsert';
    let rows: unknown[] = [];
    let docIdEq: string | null = null;
    const b: Record<string, unknown> = {};
    b.upsert = (r: unknown[]) => {
      op = 'upsert';
      rows = r;
      return b;
    };
    b.delete = () => {
      op = 'delete';
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      if (col === 'doc_id') docIdEq = val as string;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (op === 'delete' && docIdEq !== null) {
        chunkClears.push(docIdEq);
      } else if (op === 'upsert') {
        const docId = (rows[0] as { doc_id?: string } | undefined)?.doc_id ?? '?';
        chunkUpserts.push({ docId, count: rows.length });
      }
      return resolve({ error: null });
    };
    return b;
  }

  function embeddingsBuilder() {
    let rows: unknown[] = [];
    const b: Record<string, unknown> = {};
    b.upsert = (r: unknown[]) => {
      rows = r;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      embeddingUpserts.push(rows.length);
      return resolve({ error: null });
    };
    return b;
  }

  function sourcesBuilder() {
    let vals: Record<string, unknown> = {};
    const neqs: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.update = (v: Record<string, unknown>) => {
      vals = v;
      return b;
    };
    b.eq = () => b;
    b.neq = (col: string, val: unknown) => {
      neqs[col] = val;
      return b;
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      // Record the neq filters alongside the payload so tests can assert
      // the sticky-removal guard is present on status writes.
      sourceUpdates.push({ ...vals, __neq: { ...neqs } });
      return resolve({ error: null });
    };
    return b;
  }

  const db = {
    from(table: string) {
      if (table === 'docs') return docsBuilder();
      if (table === 'doc_chunks') return chunksBuilder();
      if (table === 'corpus_chunk_embeddings') return embeddingsBuilder();
      if (table === 'sources') return sourcesBuilder();
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return {
    db,
    docIds: () => [...docs.keys()].sort(),
    docHash: (id: string) => docs.get(id)?.content_hash ?? null,
    chunkClears: () => chunkClears,
    chunkUpserts: () => chunkUpserts,
    embeddingUpserts: () => embeddingUpserts,
    pruned: () => pruned.sort(),
    sourceUpdates: () => sourceUpdates,
  };
}

// Inline step runner: execute each step body immediately.
const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() };

/**
 * A CorpusWriteClient that replays writeReconciledDoc's writes through the
 * in-memory supabase mock, so the existing corpus-state assertions
 * (chunkUpserts / embeddingUpserts / chunkClears / docHash) keep working even
 * though production now writes via direct Postgres. Mirrors the pre-refactor
 * write sequence exactly.
 */
function supabaseBackedWriter(db: SupabaseClient): import('../../src/inngest/lib/corpus-reconcile').CorpusWriteClient {
  return {
    async writeDoc(w) {
      if (w.kind === 'changed') {
        await db.from('doc_chunks').delete().eq('org_id', w.doc.orgId).eq('doc_id', w.docId);
      }
      await db.from('docs').upsert({
        id: w.docId,
        org_id: w.doc.orgId,
        source_id: w.doc.sourceId,
        source: w.doc.source,
        type: w.doc.type,
        title: w.doc.title,
        url: w.doc.url,
        provenance: w.doc.provenance,
        updated_at: w.doc.updatedAt,
        content_hash: w.hash,
      });
      const chunkRows = w.chunks.map((c) => ({
        chunk_id: c.chunkId,
        org_id: w.doc.orgId,
        source_id: w.doc.sourceId,
        doc_id: w.docId,
        domain: c.domain,
        text: c.text,
        context: c.context ?? null,
        is_summary: c.isSummary ?? false,
        position: c.position,
      }));
      await db.from('doc_chunks').upsert(chunkRows, { onConflict: 'chunk_id' });
      const embedRows = w.chunks.map((c, i) => ({
        chunk_id: c.chunkId,
        org_id: w.doc.orgId,
        source_id: w.doc.sourceId,
        domain: c.domain,
        embedding: w.embeddings[i]!,
      }));
      await db.from('corpus_chunk_embeddings').upsert(embedRows, { onConflict: 'chunk_id' });
    },
    async clearChunks(docId, orgId) {
      await db.from('doc_chunks').delete().eq('org_id', orgId).eq('doc_id', docId);
    },
  };
}

interface Entity {
  id: string;
  text: string;
}

function docIdFor(e: Entity): string {
  return `doc:${e.id}`;
}
function hashFor(e: Entity): string {
  return contentHashFromTexts([e.text]);
}

/** Build a config with the test's entities; prepare is one chunk per entity. */
function config(opts: {
  entities: Entity[];
  mode?: 'delta' | 'full';
  isAuthError?: (e: unknown) => boolean;
  fetchEntities?: () => Promise<readonly Entity[]>;
}) {
  return {
    step,
    orgId: 'org1',
    sourceId: 'src1',
    mode: opts.mode,
    source: 'trello',
    docType: 'card',
    provenance: 'trusted' as const,
    reconnectMessage: 'reconnect',
    isAuthError: opts.isAuthError ?? (() => false),
    fetchEntities: opts.fetchEntities ?? (() => Promise.resolve(opts.entities)),
    // Writes route through the same in-memory mock as reads (production uses
    // the direct-Postgres writer, exercised in corpus-pg.test.ts).
    corpusWriter: supabaseBackedWriter(currentDb),
    prepare: async (e: Entity): Promise<PreparedDoc | null> => ({
      docId: docIdFor(e),
      title: `Card ${e.id}`,
      url: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      chunks: [{ text: e.text, domain: 'text' as const }],
    }),
  };
}

beforeEach(() => {
  embedCalls.length = 0;
  process.env['VOYAGE_API_KEY'] = 'test-key';
  h.embedImpl.fn = (items) => ({ vectors: items.map(() => ({ vector: new Float32Array([0.1]) })) });
});

describe('runConnectorIndex — skip unchanged', () => {
  it('re-indexing with no changes embeds nothing and prunes nothing', async () => {
    const e: Entity = { id: '1', text: 'alpha' };
    const mock = makeCorpusDb([{ id: docIdFor(e), type: 'card', content_hash: hashFor(e) }]);
    currentDb = mock.db;

    const res = await runConnectorIndex(config({ entities: [e], mode: 'full' }));

    expect(embedCalls).toHaveLength(0);
    expect(mock.chunkUpserts()).toEqual([]);
    expect(mock.pruned()).toEqual([]);
    expect(res.items).toBe(1);
    expect(res.chunks).toBe(1);
    // Finalize reflects the whole source even though nothing was re-embedded.
    const fin = mock.sourceUpdates().at(-1);
    expect(fin).toMatchObject({ status: 'idle', indexed_files: 1, total_files: 1, chunk_count: 1 });
  });
});

describe('runConnectorIndex — changed item', () => {
  it('clears old chunks, re-embeds, and stamps the new hash atomically', async () => {
    const e: Entity = { id: '1', text: 'new body' };
    const mock = makeCorpusDb([{ id: docIdFor(e), type: 'card', content_hash: 'STALE' }]);
    currentDb = mock.db;

    await runConnectorIndex(config({ entities: [e], mode: 'full' }));

    expect(mock.chunkClears()).toEqual([docIdFor(e)]); // cleared before re-insert
    expect(embedCalls).toHaveLength(1);
    expect(mock.embeddingUpserts()).toEqual([1]);
    // content_hash stamped to the fresh fingerprint only after the write.
    expect(mock.docHash(docIdFor(e))).toBe(hashFor(e));
  });
});

describe('runConnectorIndex — removed item', () => {
  const present: Entity = { id: '1', text: 'alpha' };
  const seed = (): SeedDoc[] => [
    { id: docIdFor(present), type: 'card', content_hash: hashFor(present) },
    { id: 'doc:gone', type: 'card', content_hash: 'whatever' },
  ];

  it('full mode prunes the removed doc', async () => {
    const mock = makeCorpusDb(seed());
    currentDb = mock.db;
    await runConnectorIndex(config({ entities: [present], mode: 'full' }));
    expect(mock.pruned()).toEqual(['doc:gone']);
    expect(mock.docIds()).toEqual([docIdFor(present)]);
  });

  it('delta mode prunes too — these connectors fetch the complete set every run', async () => {
    // runConnectorIndex always passes fetchComplete: true (fetchEntities
    // contracts to return the WHOLE entity set or throw), and the prune is
    // gated on fetch completeness, not mode (delta-prune-on-complete-fetch)
    // — otherwise a removed card/issue/page would linger until someone
    // manually ran a full reindex.
    const mock = makeCorpusDb(seed());
    currentDb = mock.db;
    await runConnectorIndex(config({ entities: [present], mode: 'delta' }));
    expect(mock.pruned()).toEqual(['doc:gone']);
    expect(mock.docIds()).toEqual([docIdFor(present)]);
  });

  it('missing mode defaults to delta and still prunes on the complete fetch', async () => {
    const mock = makeCorpusDb(seed());
    currentDb = mock.db;
    await runConnectorIndex(config({ entities: [present] }));
    expect(mock.pruned()).toEqual(['doc:gone']);
  });
});

describe('runConnectorIndex — empty source', () => {
  it('full mode with the whole source emptied prunes all (confirmedEmpty path)', async () => {
    const mock = makeCorpusDb([
      { id: 'doc:a', type: 'card', content_hash: 'h1' },
      { id: 'doc:b', type: 'card', content_hash: 'h2' },
    ]);
    currentDb = mock.db;
    const res = await runConnectorIndex(config({ entities: [], mode: 'full' }));
    expect(mock.pruned()).toEqual(['doc:a', 'doc:b']);
    expect(res.items).toBe(0);
    expect(res.chunks).toBe(0);
  });

  it('delta mode with empty fetch keeps existing docs', async () => {
    const mock = makeCorpusDb([{ id: 'doc:a', type: 'card', content_hash: 'h1' }]);
    currentDb = mock.db;
    await runConnectorIndex(config({ entities: [], mode: 'delta' }));
    expect(mock.pruned()).toEqual([]);
  });
});

describe('runConnectorIndex — atomicity on failure', () => {
  it('throws when a changed item fails to embed (no chunkless doc)', async () => {
    const e: Entity = { id: '1', text: 'new body' };
    const mock = makeCorpusDb([{ id: docIdFor(e), type: 'card', content_hash: 'STALE' }]);
    currentDb = mock.db;
    h.embedImpl.fn = () => {
      throw new Error('voyage 500');
    };

    await expect(runConnectorIndex(config({ entities: [e], mode: 'full' }))).rejects.toThrow(/embed failed for changed/);
    // The old chunks were never cleared (clear happens inside writeReconciledDoc,
    // after a successful embed) so the prior version stays intact.
    expect(mock.chunkClears()).toEqual([]);
    expect(mock.docHash(docIdFor(e))).toBe('STALE');
  });

  it('skips (does not throw) when a NEW item fails to embed', async () => {
    const e: Entity = { id: '1', text: 'alpha' };
    const mock = makeCorpusDb([]); // nothing exists → 'new'
    currentDb = mock.db;
    h.embedImpl.fn = () => {
      throw new Error('voyage 500');
    };
    const res = await runConnectorIndex(config({ entities: [e], mode: 'full' }));
    expect(res.items).toBe(1); // counted in the source total
    expect(mock.docIds()).toEqual([]); // but nothing written
  });
});

describe('runConnectorIndex — auth revoked', () => {
  it('marks the source errored and embeds nothing', async () => {
    class AuthErr extends Error {}
    const mock = makeCorpusDb([]);
    currentDb = mock.db;
    const res = await runConnectorIndex(
      config({
        entities: [],
        isAuthError: (err) => err instanceof AuthErr,
        fetchEntities: () => Promise.reject(new AuthErr('revoked')),
      }),
    );
    expect(res.error).toBe('connector_auth');
    expect(embedCalls).toHaveLength(0);
    expect(mock.sourceUpdates().some((u) => u['status'] === 'errored')).toBe(true);
  });
});

describe('runConnectorIndex — sticky removal (deselect↔index race)', () => {
  // Regression for the Trello 88-cards bug: a board deselected while its
  // index run was in flight had status='removed' clobbered back to 'idle'
  // by the finalize write, so the purge cron (which keys on
  // status='removed') never deleted its content. Every status write the
  // orchestrator makes must carry the .neq('status','removed') guard so
  // an in-flight run can never resurrect a removed source.
  it('finalize carries the sticky-removal guard', async () => {
    const e: Entity = { id: '1', text: 'alpha' };
    const mock = makeCorpusDb([]);
    currentDb = mock.db;

    await runConnectorIndex(config({ entities: [e], mode: 'full' }));

    const statusWrites = mock.sourceUpdates().filter((u) => u['status'] !== undefined);
    expect(statusWrites.length).toBeGreaterThan(0);
    for (const w of statusWrites) {
      expect(w['__neq']).toMatchObject({ status: 'removed' });
    }
  });

  it('mark-errored carries the sticky-removal guard', async () => {
    class AuthErr extends Error {}
    const mock = makeCorpusDb([]);
    currentDb = mock.db;
    await runConnectorIndex(
      config({
        entities: [],
        isAuthError: (err) => err instanceof AuthErr,
        fetchEntities: () => Promise.reject(new AuthErr('revoked')),
      }),
    );
    const errored = mock.sourceUpdates().find((u) => u['status'] === 'errored');
    expect(errored).toBeDefined();
    expect(errored?.['__neq']).toMatchObject({ status: 'removed' });
  });
});
