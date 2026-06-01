/**
 * Corpus eval replay runner (U1).
 *
 * Replays each labeled question in golden-questions.jsonl through the REAL
 * retrieval + synthesis path (embed -> hybridSearch -> enrich -> synthesize)
 * and reports per-question recall on the labeled must-surface set plus the
 * synthesized answer / refusal. This is the yardstick every later phase of
 * the Claude-augmented RAG plan reports against.
 *
 * Usage (from apps/bot-worker):
 *   pnpm tsx --env-file=.env eval/replay.ts <orgId>
 *   # or set RISEZOME_EVAL_ORG_ID
 *
 * Env: SUPABASE_URL, SUPABASE_SECRET_KEY, VOYAGE_API_KEY, ANTHROPIC_API_KEY.
 * Read-only against the corpus; no writes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VoyageEmbedder } from '@risezome/engine/embed';
import {
  AnthropicSynthesizer,
  parseSynthesisOutput,
  type SynthesisSource,
} from '@risezome/engine/synthesize';
import { createServiceClient } from '../src/db.js';
import { hybridSearch } from '../src/corpus-search.js';
import {
  scoreQuestion,
  summarize,
  type GoldenQuestion,
  type RetrievedDoc,
  type QuestionResult,
} from './lib/corpus-replay.js';

const TOP_K = 5;

const silentLogger = { warn: () => undefined };

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function loadGoldenSet(): GoldenQuestion[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'golden-questions.jsonl'), 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GoldenQuestion);
}

async function replayOne(
  deps: { db: ReturnType<typeof createServiceClient>; embedder: VoyageEmbedder; synthesizer: AnthropicSynthesizer; orgId: string },
  question: GoldenQuestion,
): Promise<QuestionResult> {
  // 1) embed the question
  const embedResult = await deps.embedder.embed({ items: [{ text: question.q, domain: 'text' }] });
  const vec = embedResult.vectors[0]?.vector;
  if (vec === undefined) {
    return scoreQuestion(question, [], '', true);
  }
  const queryVectorLiteral = `[${Array.from(vec).join(',')}]`;

  // 2) hybrid search (the real query path)
  const hits = await hybridSearch(deps.db, {
    orgId: deps.orgId,
    queryVectorLiteral,
    queryText: question.q,
    limit: TOP_K,
    logger: silentLogger,
  });
  if (hits.length === 0) {
    return scoreQuestion(question, [], '', true);
  }

  // 3) enrich chunk -> doc (mirrors apps/bot-worker/src/retrieval.ts)
  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await deps.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, text')
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [c.chunk_id as string, { docId: c.doc_id as string, text: c.text as string }]),
  );
  const docIds = [...new Set([...chunkById.values()].map((c) => c.docId))];
  const { data: docRows } = await deps.db.from('docs').select('id, title').in('id', docIds);
  const titleById = new Map((docRows ?? []).map((d) => [d.id as string, d.title as string]));

  const retrieved: RetrievedDoc[] = [];
  const sources: SynthesisSource[] = [];
  hits.forEach((h, i) => {
    const chunk = chunkById.get(h.chunk_id);
    if (chunk === undefined) return;
    const title = titleById.get(chunk.docId) ?? chunk.docId;
    retrieved.push({ chunkId: h.chunk_id, docId: chunk.docId, title, score: h.score });
    sources.push({ rank: i + 1, title, text: chunk.text });
  });

  // 4) synthesize (consume the stream, parse for refusal + body)
  let accumulated = '';
  for await (const chunk of deps.synthesizer.synthesize({ utterance: question.q, sources })) {
    if (chunk.type === 'textDelta') accumulated += chunk.delta;
  }
  const parsed = parseSynthesisOutput(accumulated, sources.length);

  return scoreQuestion(question, retrieved, parsed.text, parsed.isRefusal);
}

async function main(): Promise<void> {
  const orgId = process.argv[2] ?? process.env.RISEZOME_EVAL_ORG_ID;
  if (orgId === undefined || orgId.length === 0) {
    console.error('Usage: tsx --env-file=.env eval/replay.ts <orgId>  (or set RISEZOME_EVAL_ORG_ID)');
    process.exit(1);
  }
  const deps = {
    db: createServiceClient(),
    embedder: new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') }),
    synthesizer: new AnthropicSynthesizer({ apiKey: requireEnv('ANTHROPIC_API_KEY') }),
    orgId,
  };

  const questions = loadGoldenSet();
  const results: QuestionResult[] = [];
  for (const q of questions) {
    process.stderr.write(`  replaying: ${q.q}\n`);
    results.push(await replayOne(deps, q));
  }

  const summary = summarize(results);
  // Human-readable report to stderr; machine-readable JSON to stdout.
  process.stderr.write(
    `\n=== Corpus eval: ${String(summary.passed)}/${String(summary.total)} pass ` +
      `(${(summary.passRate * 100).toFixed(0)}%), mean recall ` +
      `${summary.meanRecall === null ? 'n/a' : summary.meanRecall.toFixed(2)} ===\n`,
  );
  for (const r of summary.results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    const recallStr = r.recall === null ? '—' : `${(r.recall * 100).toFixed(0)}%`;
    process.stderr.write(
      `  [${mark}] recall=${recallStr} refusal=${String(r.isRefusal)} :: ${r.q}\n` +
        (r.missed.length > 0 ? `         missed: ${r.missed.join(', ')}\n` : ''),
    );
  }
  process.stdout.write(JSON.stringify(summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
