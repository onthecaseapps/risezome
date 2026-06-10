import { describe, expect, it } from 'vitest';
import { pgCorpusWriter, TRANSIENT_PG_ERROR_RE } from '../../src/inngest/lib/corpus-pg';
import type { ReconciledDocWrite } from '../../src/inngest/lib/corpus-reconcile';

/**
 * Minimal stand-in for a postgres.js `Sql`. It is callable as a tagged
 * template (records the joined static SQL), exposes `.begin` (runs the
 * callback with itself as the tx), and `.json` (identity passthrough). Lets us
 * assert WHICH statements pgCorpusWriter issues without a real database.
 */
function fakeSql() {
  const queries: string[] = [];
  // `tag` is both the template function and carries .begin/.json.
  const tag = (strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> => {
    queries.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return Promise.resolve([]);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = tag as any;
  sql.begin = async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(sql);
  sql.json = (v: unknown): unknown => v;
  return { sql, queries };
}

const baseWrite: ReconciledDocWrite = {
  docId: 'doc:1',
  kind: 'new',
  hash: 'h1',
  doc: {
    orgId: '11111111-1111-1111-1111-111111111111',
    sourceId: '22222222-2222-2222-2222-222222222222',
    source: 'github',
    type: 'file',
    title: 'review/_client.tsx',
    url: null,
    provenance: 'trusted',
    updatedAt: '2026-06-10T00:00:00.000Z',
  },
  // A chunk whose body is exactly the kind of HTML the WAF blocked.
  chunks: [{ chunkId: 'doc:1::0', domain: 'code', text: '<!DOCTYPE html><script>x</script>', context: '', position: 0 }],
  embeddings: ['[0.1,0.2]'],
};

describe('TRANSIENT_PG_ERROR_RE', () => {
  it('matches dropped/closed connection failures', () => {
    expect(TRANSIENT_PG_ERROR_RE.test('write ECONNRESET')).toBe(true);
    expect(TRANSIENT_PG_ERROR_RE.test('Connection ended unexpectedly')).toBe(true);
    expect(TRANSIENT_PG_ERROR_RE.test('terminating connection due to administrator command')).toBe(true);
    expect(TRANSIENT_PG_ERROR_RE.test('too many connections for role')).toBe(true);
  });

  it('does NOT match genuine SQL errors', () => {
    expect(TRANSIENT_PG_ERROR_RE.test('duplicate key value violates unique constraint')).toBe(false);
    expect(TRANSIENT_PG_ERROR_RE.test('null value in column "org_id" violates not-null constraint')).toBe(false);
    expect(TRANSIENT_PG_ERROR_RE.test('invalid input syntax for type vector')).toBe(false);
  });
});

describe('pgCorpusWriter', () => {
  it('writes a new doc in one transaction: docs + chunks + embeddings, no delete', async () => {
    const { sql, queries } = fakeSql();
    await pgCorpusWriter(sql).writeDoc(baseWrite);
    const joined = queries.join('\n');
    expect(joined).toContain('insert into public.docs');
    expect(joined).toContain('insert into public.doc_chunks');
    expect(joined).toContain('insert into public.corpus_chunk_embeddings');
    expect(joined).toContain('::vector'); // embedding cast
    expect(joined).not.toContain('delete from public.doc_chunks');
  });

  it('clears stale chunks first for a CHANGED doc', async () => {
    const { sql, queries } = fakeSql();
    await pgCorpusWriter(sql).writeDoc({ ...baseWrite, kind: 'changed' });
    expect(queries[0]).toContain('delete from public.doc_chunks');
    expect(queries.join('\n')).toContain('insert into public.docs');
  });

  it('skips chunk/embedding inserts when there are no chunks', async () => {
    const { sql, queries } = fakeSql();
    await pgCorpusWriter(sql).writeDoc({ ...baseWrite, chunks: [], embeddings: [] });
    const joined = queries.join('\n');
    expect(joined).toContain('insert into public.docs');
    expect(joined).not.toContain('insert into public.doc_chunks');
    expect(joined).not.toContain('insert into public.corpus_chunk_embeddings');
  });

  it('rejects a chunk/embedding length mismatch', async () => {
    const { sql } = fakeSql();
    await expect(
      pgCorpusWriter(sql).writeDoc({ ...baseWrite, embeddings: ['[0.1]', '[0.2]'] }),
    ).rejects.toThrow(/length mismatch/);
  });

  it('clearChunks issues an org-scoped delete', async () => {
    const { sql, queries } = fakeSql();
    await pgCorpusWriter(sql).clearChunks('doc:1', 'org-1');
    expect(queries.join('\n')).toContain('delete from public.doc_chunks where org_id =');
  });
});
