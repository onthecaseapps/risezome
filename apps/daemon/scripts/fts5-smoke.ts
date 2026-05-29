import { openCorpusDb } from '../src/corpus/db.js';

async function main() {
  const db = await openCorpusDb();

  console.log('=== sample chunk text (first 3 issue chunks) ===');
  const samples = db.prepare(
    "SELECT text FROM doc_chunks WHERE doc_id LIKE '%issue:%' LIMIT 3",
  ).all() as { text: string }[];
  for (const r of samples) console.log(r.text.slice(0, 120) + '...\n---');

  console.log('\n=== FTS5 phrase candidates ===');
  const forms = [
    '"Status: open"',
    '"Status open"',
    'Status open',
    '"Labels: bug"',
    '"Labels bug"',
    '"Status open" AND "Labels bug"',
    '"Status: open" AND "Labels: bug"',
  ];
  for (const form of forms) {
    try {
      const r = db.prepare(
        `SELECT COUNT(DISTINCT doc_id) AS n FROM fts_doc_chunks WHERE fts_doc_chunks MATCH ?`,
      ).get(form) as { n: number };
      console.log(`  ${JSON.stringify(form).padEnd(45)} -> ${String(r.n)} distinct docs`);
    } catch (e) {
      console.log(`  ${JSON.stringify(form).padEnd(45)} -> ERROR: ${(e as Error).message}`);
    }
  }

  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
