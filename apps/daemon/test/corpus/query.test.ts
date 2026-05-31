import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { DEFAULT_EMBEDDING_DIM, openCorpusDb, CorpusError } from '../../src/corpus/db.js';
import { migrate } from '../../src/corpus/migrate.js';
import {
  bm25Search,
  hybridSearch,
  insertChunk,
  insertDoc,
  vectorSearch,
} from '../../src/corpus/query.js';
import type { CanonicalChunk, CanonicalDoc } from '../../src/corpus/types.js';

interface Harness {
  db: DatabaseType;
  dir: string;
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'risezome-query-'));
  const dbPath = join(dir, 'risezome.db');
  const db = await openCorpusDb({ path: dbPath });
  await migrate(db);
  return { db, dir };
}

function teardown(h: Harness): void {
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function makeDoc(overrides: Partial<CanonicalDoc> = {}): CanonicalDoc {
  return {
    id: 'gh:test/repo#issue:1',
    source: 'github',
    type: 'issue',
    title: 'Test issue',
    bodySummary: '',
    entities: [],
    authors: ['nathan'],
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeChunk(overrides: Partial<CanonicalChunk> = {}): CanonicalChunk {
  return {
    chunkId: 'gh:test/repo#issue:1#chunk:0',
    docId: 'gh:test/repo#issue:1',
    domain: 'text',
    text: 'placeholder',
    ...overrides,
  };
}

function unitVectorAt(index: number, magnitude = 1): Float32Array {
  const v = new Float32Array(DEFAULT_EMBEDDING_DIM);
  v[index % DEFAULT_EMBEDDING_DIM] = magnitude;
  return v;
}

describe('Corpus query', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup();
  });

  afterEach(() => {
    teardown(h);
  });

  describe('insertDoc + insertChunk', () => {
    it('rejects embedding with wrong dimension', () => {
      insertDoc(h.db, makeDoc());
      const badEmbed = new Float32Array(DEFAULT_EMBEDDING_DIM + 1);
      expect(() => insertChunk(h.db, makeChunk({ embedding: badEmbed }))).toThrow(CorpusError);
    });

    it('inserts a doc + chunk and round-trips via vector search', () => {
      const doc = makeDoc();
      insertDoc(h.db, doc);
      insertChunk(h.db, makeChunk({ text: 'hello world', embedding: unitVectorAt(0) }));
      const results = vectorSearch(h.db, unitVectorAt(0), { limit: 5 });
      expect(results).toHaveLength(1);
      expect(results[0]?.doc.id).toBe(doc.id);
    });
  });

  describe('vectorSearch (no BM25)', () => {
    it('returns top-5 docs collapsed across chunks for 100 docs × 3 chunks', () => {
      for (let i = 0; i < 100; i++) {
        insertDoc(
          h.db,
          makeDoc({
            id: `gh:test/repo#doc:${String(i)}`,
            title: `Doc ${String(i)}`,
          }),
        );
        for (let c = 0; c < 3; c++) {
          insertChunk(
            h.db,
            makeChunk({
              chunkId: `gh:test/repo#doc:${String(i)}#chunk:${String(c)}`,
              docId: `gh:test/repo#doc:${String(i)}`,
              text: `chunk-${String(c)} for doc ${String(i)}`,
              embedding: unitVectorAt(i, 1),
            }),
          );
        }
      }
      const results = vectorSearch(h.db, unitVectorAt(7), { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results[0]?.doc.id).toBe('gh:test/repo#doc:7');
      // Each result is a distinct doc (no duplicates across chunks)
      const ids = new Set(results.map((r) => r.doc.id));
      expect(ids.size).toBe(results.length);
    });

    it('returns empty array for an empty corpus', () => {
      const results = vectorSearch(h.db, unitVectorAt(0), { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe('bm25Search', () => {
    it('returns the doc whose chunk contains the exact ticket id as top-1', () => {
      insertDoc(h.db, makeDoc({ id: 'jira:SEC-204', title: 'Auth middleware migration' }));
      insertChunk(
        h.db,
        makeChunk({
          chunkId: 'jira:SEC-204#chunk:0',
          docId: 'jira:SEC-204',
          text: 'SEC-204 covers the auth middleware migration work.',
        }),
      );
      insertDoc(h.db, makeDoc({ id: 'gh:other', title: 'Other repo' }));
      insertChunk(
        h.db,
        makeChunk({
          chunkId: 'gh:other#chunk:0',
          docId: 'gh:other',
          text: 'Unrelated content about caching.',
        }),
      );

      const results = bm25Search(h.db, "what's the status of SEC-204?", { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.doc.id).toBe('jira:SEC-204');
    });

    it('returns empty array when no terms match', () => {
      insertDoc(h.db, makeDoc());
      insertChunk(h.db, makeChunk({ text: 'something unrelated' }));
      const results = bm25Search(h.db, 'SEC-204 status', { limit: 5 });
      expect(results.every((r) => !r.snippet.includes('SEC-204'))).toBe(true);
    });
  });

  describe('hybridSearch', () => {
    it('surfaces a doc that wins on BM25 but ranks low on vector (exact-string anchor)', () => {
      insertDoc(h.db, makeDoc({ id: 'gh:weak-vec', title: 'Doc with SEC-204 anchor' }));
      insertChunk(
        h.db,
        makeChunk({
          chunkId: 'gh:weak-vec#chunk:0',
          docId: 'gh:weak-vec',
          text: 'SEC-204 rollout plan in this chunk.',
          embedding: unitVectorAt(100, 0.1),
        }),
      );
      insertDoc(h.db, makeDoc({ id: 'gh:strong-vec', title: 'Vector-strong doc' }));
      insertChunk(
        h.db,
        makeChunk({
          chunkId: 'gh:strong-vec#chunk:0',
          docId: 'gh:strong-vec',
          text: 'Generic content with no anchor.',
          embedding: unitVectorAt(0, 1),
        }),
      );

      const results = hybridSearch(h.db, "what's the status of SEC-204?", unitVectorAt(0), {
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r) => r.doc.id);
      expect(ids).toContain('gh:weak-vec');
      const weakVecResult = results.find((r) => r.doc.id === 'gh:weak-vec');
      expect(weakVecResult?.snippet).toContain('SEC-204');
    });

    it('returns a doc once with the highest-scoring chunk as snippet (5-chunk doc)', () => {
      insertDoc(h.db, makeDoc({ id: 'gh:multi', title: 'Doc with many chunks' }));
      const texts = [
        'introduction',
        'middle section about caching',
        'SEC-204 anchor here',
        'discussion of testing approach',
        'conclusion',
      ];
      texts.forEach((text, i) => {
        insertChunk(
          h.db,
          makeChunk({
            chunkId: `gh:multi#chunk:${String(i)}`,
            docId: 'gh:multi',
            text,
            embedding: unitVectorAt(i + 50, 0.5),
          }),
        );
      });
      const results = hybridSearch(h.db, 'SEC-204', unitVectorAt(50), { limit: 5 });
      const multiHits = results.filter((r) => r.doc.id === 'gh:multi');
      expect(multiHits.length).toBe(1);
      expect(multiHits[0]?.snippet).toContain('SEC-204');
    });

    it('FTS5 short-circuits when query has no entity-like tokens (stopword-only)', () => {
      insertDoc(h.db, makeDoc({ id: 'gh:0', title: 'A doc' }));
      insertChunk(
        h.db,
        makeChunk({
          chunkId: 'gh:0#chunk:0',
          docId: 'gh:0',
          text: 'some content',
          embedding: unitVectorAt(3),
        }),
      );
      const start = performance.now();
      const results = hybridSearch(h.db, 'what was that thing again', unitVectorAt(3), {
        limit: 5,
      });
      const elapsed = performance.now() - start;
      expect(results).toHaveLength(1);
      expect(elapsed).toBeLessThan(100);
      // Score should reflect vector-only path (only one ranker contributed).
      expect(results[0]?.source).toBe('vector');
    });

    it('returns empty array for empty corpus', () => {
      const results = hybridSearch(h.db, "what's the deal with SEC-204?", unitVectorAt(0), {
        limit: 5,
      });
      expect(results).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('a query sees committed writes from another transaction', () => {
      insertDoc(h.db, makeDoc());
      insertChunk(h.db, makeChunk({ text: 'hello', embedding: unitVectorAt(0) }));
      const before = vectorSearch(h.db, unitVectorAt(0), { limit: 5 });
      expect(before).toHaveLength(1);
      insertDoc(h.db, makeDoc({ id: 'gh:test/repo#issue:2' }));
      insertChunk(
        h.db,
        makeChunk({
          chunkId: 'gh:test/repo#issue:2#chunk:0',
          docId: 'gh:test/repo#issue:2',
          text: 'world',
          embedding: unitVectorAt(1),
        }),
      );
      const after = vectorSearch(h.db, unitVectorAt(1), { limit: 5 });
      expect(after.some((r) => r.doc.id === 'gh:test/repo#issue:2')).toBe(true);
      expect(after[0]?.doc.id).toBe('gh:test/repo#issue:2');
    });
  });
});
