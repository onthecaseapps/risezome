// One-off: clear all embedding chunks (doc_chunks + vec_doc_chunks) so the
// next `pnpm daemon index` re-embeds against the current chunker output.
//
// Docs and consent grants are preserved. Used when chunker logic changes
// invalidate stored embeddings but the chunkIds stay stable (so the resume
// helper would falsely report cache hits).
//
// Usage: pnpm exec tsx apps/daemon/scripts/clear-chunks.ts

import { openCorpusDb } from '../src/corpus/db.js';
import { migrate } from '../src/corpus/migrate.js';

async function main(): Promise<void> {
  const db = await openCorpusDb();
  await migrate(db);
  const beforeChunks = (db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get() as { n: number }).n;
  const beforeVec = (
    db.prepare('SELECT COUNT(*) AS n FROM vec_doc_chunks').get() as { n: number }
  ).n;
  const docs = (db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
  console.log(`before: doc_chunks=${String(beforeChunks)} vec_doc_chunks=${String(beforeVec)} docs=${String(docs)}`);
  db.exec('BEGIN;');
  db.exec('DELETE FROM doc_chunks;');
  db.exec('DELETE FROM vec_doc_chunks;');
  db.exec('COMMIT;');
  const afterChunks = (db.prepare('SELECT COUNT(*) AS n FROM doc_chunks').get() as { n: number }).n;
  const afterVec = (
    db.prepare('SELECT COUNT(*) AS n FROM vec_doc_chunks').get() as { n: number }
  ).n;
  console.log(`after:  doc_chunks=${String(afterChunks)} vec_doc_chunks=${String(afterVec)} docs=${String(docs)}`);
  db.close();
}

void main();
