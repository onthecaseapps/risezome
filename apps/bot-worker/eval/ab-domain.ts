/**
 * Focused A/B for the domain-partitioned dense search (#2b) + input_type=query
 * (#3). Retrieval-ONLY (no synthesis) so it's fast and cheap. For each
 * code-resident question it runs hybridSearch two ways against the real corpus:
 *   BASELINE  — single text-space query vector over ALL chunks (the old
 *               behavior: a voyage-3-large query vs mixed code/text doc vectors)
 *   PARTITIONED — text query vs text chunks + code query vs code chunks, fused
 * and reports the top-5 titles + whether a CODE chunk surfaced in the top-5.
 *
 * Usage (from apps/bot-worker):
 *   pnpm tsx --env-file=.env eval/ab-domain.ts <orgId>
 */
import { VoyageEmbedder } from '@risezome/engine/embed';
import { createServiceClient } from '../src/db.js';
import { hybridSearch } from '../src/corpus-search.js';

const QUESTIONS = [
  'what fusion algorithm combines vector and keyword search results',
  'which embedding model is used for code versus prose',
  'what cross encoder model reranks the retrieved candidates',
  'how is the relevance gate timeout configured',
  'how does the bot authenticate its websocket connection',
  'what is the maximum number of tokens a synthesis can produce',
];

async function literal(emb: VoyageEmbedder, text: string, domain: 'text' | 'code'): Promise<string> {
  const r = await emb.embed({ items: [{ text, domain }], purpose: 'query' });
  return `[${Array.from(r.vectors[0]!.vector).join(',')}]`;
}

async function main(): Promise<void> {
  const orgId = process.argv[2] ?? process.env.RISEZOME_EVAL_ORG_ID;
  if (orgId === undefined || orgId.length === 0) {
    console.error('Usage: tsx --env-file=.env eval/ab-domain.ts <orgId>');
    process.exit(1);
  }
  const db = createServiceClient();
  const emb = new VoyageEmbedder({ apiKey: process.env.VOYAGE_API_KEY ?? '' });

  // Pull the per-chunk domain so we can tag which results are code.
  const { data: domainRows } = await db
    .from('doc_chunks')
    .select('chunk_id, domain')
    .eq('org_id', orgId)
    .limit(100000);
  const domainByChunk = new Map((domainRows ?? []).map((r) => [r.chunk_id as string, r.domain as string]));

  let baseCodeHits = 0;
  let partCodeHits = 0;
  for (const q of QUESTIONS) {
    const [textLit, codeLit] = await Promise.all([literal(emb, q, 'text'), literal(emb, q, 'code')]);

    const baseline = await hybridSearch(db, {
      orgId,
      queryVectorLiteral: textLit,
      queryText: q,
      limit: 5,
    });
    const partitioned = await hybridSearch(db, {
      orgId,
      queryVectorLiteral: textLit,
      codeQueryVectorLiteral: codeLit,
      queryText: q,
      limit: 5,
    });

    const codeIn = (ids: string[]): number => ids.filter((id) => domainByChunk.get(id) === 'code').length;
    const baseIds = baseline.map((h) => h.chunk_id);
    const partIds = partitioned.map((h) => h.chunk_id);
    const bc = codeIn(baseIds);
    const pc = codeIn(partIds);
    if (bc > 0) baseCodeHits += 1;
    if (pc > 0) partCodeHits += 1;

    const newInTop = partIds.filter((id) => !baseIds.includes(id));
    process.stdout.write(
      `\nQ: ${q}\n` +
        `   baseline    top5 code-chunks: ${String(bc)}/5  [${baseIds.map((id) => domainByChunk.get(id) ?? '?').join(',')}]\n` +
        `   partitioned top5 code-chunks: ${String(pc)}/5  [${partIds.map((id) => domainByChunk.get(id) ?? '?').join(',')}]\n` +
        `   chunks surfaced ONLY by partitioned: ${String(newInTop.length)}\n`,
    );
  }

  process.stdout.write(
    `\n=== Summary over ${String(QUESTIONS.length)} code-resident questions ===\n` +
      `  questions with >=1 CODE chunk in top-5:  baseline ${String(baseCodeHits)}  →  partitioned ${String(partCodeHits)}\n`,
  );
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
