import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openCorpusDb } from '../../src/corpus/db.js';
import { migrate } from '../../src/corpus/migrate.js';

interface Harness {
  db: DatabaseType;
  dir: string;
  dbPath: string;
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'risezome-corpus-'));
  const dbPath = join(dir, 'risezome.db');
  const db = await openCorpusDb({ path: dbPath });
  await migrate(db);
  return { db, dir, dbPath };
}

function teardown(h: Harness): void {
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

describe('Corpus schema + migrations', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup();
  });

  afterEach(() => {
    teardown(h);
  });

  it('applies migrations and creates all expected tables', () => {
    const tables = h.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    for (const expected of [
      'docs',
      'doc_chunks',
      'fts_doc_chunks',
      'vec_doc_chunks',
      'cursors',
      'meetings',
      'meeting_utterances',
      'gaps',
      'consent',
      'telemetry_events',
      'schema_migrations',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('re-running migrations is idempotent (no-op)', async () => {
    const before = h.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    const result = await migrate(h.db);
    const after = h.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  if (process.platform !== 'win32') {
    it('database file has mode 0600 on POSIX', () => {
      const mode = statSync(h.dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  }

  it('CHECK constraint rejects invalid chunk domain', () => {
    h.db
      .prepare(`INSERT INTO docs (id, source, type, title, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('d:1', 'test', 'note', 'Test', Date.now());
    expect(() =>
      h.db
        .prepare('INSERT INTO doc_chunks (chunk_id, doc_id, domain, text) VALUES (?, ?, ?, ?)')
        .run('d:1#chunk:0', 'd:1', 'invalid-domain', 'hello'),
    ).toThrow();
  });

  it('FOREIGN KEY cascade deletes chunks when doc is deleted', () => {
    h.db
      .prepare('INSERT INTO docs (id, source, type, title, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('d:1', 'test', 'note', 'Test', Date.now());
    h.db
      .prepare('INSERT INTO doc_chunks (chunk_id, doc_id, domain, text) VALUES (?, ?, ?, ?)')
      .run('d:1#chunk:0', 'd:1', 'text', 'body');
    h.db.prepare('DELETE FROM docs WHERE id = ?').run('d:1');
    const chunkCount = h.db
      .prepare('SELECT COUNT(*) AS n FROM doc_chunks WHERE doc_id = ?')
      .get('d:1') as { n: number };
    expect(chunkCount.n).toBe(0);
  });
});
