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
import {
  makeAnthropicJudge,
  scoreRagas,
  meanScores,
  type Judge,
  type RagasScores,
} from '@risezome/engine/eval';
import { createServiceClient } from '../src/db.js';
import { hybridSearch } from '../src/corpus-search.js';
import { optionalReranker } from '../src/reranker.js';
import { expandWinnersToParents, parentDocEnabled, type WinningChunk } from '../src/parent-doc.js';
import {
  scoreQuestion,
  summarize,
  type GoldenQuestion,
  type RetrievedDoc,
  type QuestionResult,
} from './lib/corpus-replay.js';

interface ScoredResult {
  readonly result: QuestionResult;
  readonly scores: RagasScores | null;
}

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
  deps: {
    db: ReturnType<typeof createServiceClient>;
    embedder: VoyageEmbedder;
    synthesizer: AnthropicSynthesizer;
    orgId: string;
    judge: Judge | null;
  },
  question: GoldenQuestion,
): Promise<ScoredResult> {
  // 1) embed the question
  const embedResult = await deps.embedder.embed({ items: [{ text: question.q, domain: 'text' }] });
  const vec = embedResult.vectors[0]?.vector;
  if (vec === undefined) {
    return { result: scoreQuestion(question, [], '', true), scores: null };
  }
  const queryVectorLiteral = `[${Array.from(vec).join(',')}]`;

  // 2) hybrid search (the real query path)
  const hits = await hybridSearch(deps.db, {
    orgId: deps.orgId,
    queryVectorLiteral,
    queryText: question.q,
    limit: TOP_K,
    reranker: optionalReranker(),
    logger: silentLogger,
  });
  if (hits.length === 0) {
    return { result: scoreQuestion(question, [], '', true), scores: null };
  }

  // 3) enrich chunk -> doc (mirrors apps/bot-worker/src/retrieval.ts)
  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await deps.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, text, position')
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      { docId: c.doc_id as string, text: c.text as string, position: c.position as number },
    ]),
  );
  const docIds = [...new Set([...chunkById.values()].map((c) => c.docId))];
  const { data: docRows } = await deps.db.from('docs').select('id, title').in('id', docIds);
  const titleById = new Map((docRows ?? []).map((d) => [d.id as string, d.title as string]));

  // Parent-document expansion (U8): the child won the ranking, but synthesis
  // sees the surrounding parent context. Citations/recall still key off the
  // child. No-op (child text) when the flag is off.
  const winners: WinningChunk[] = hits.flatMap((h) => {
    const c = chunkById.get(h.chunk_id);
    return c === undefined ? [] : [{ chunkId: h.chunk_id, docId: c.docId, position: c.position, text: c.text }];
  });
  const expandedByChunk = parentDocEnabled()
    ? await expandWinnersToParents(deps.db, winners)
    : new Map<string, string>();

  const retrieved: RetrievedDoc[] = [];
  const sources: SynthesisSource[] = [];
  hits.forEach((h, i) => {
    const chunk = chunkById.get(h.chunk_id);
    if (chunk === undefined) return;
    const title = titleById.get(chunk.docId) ?? chunk.docId;
    retrieved.push({ chunkId: h.chunk_id, docId: chunk.docId, title, score: h.score });
    // U8: judge relevance from the tight child (`focus`), formulate from the
    // expanded parent (`text`). Equal when expansion was a no-op / disabled.
    sources.push({ rank: i + 1, title, text: expandedByChunk.get(h.chunk_id) ?? chunk.text, focus: chunk.text });
  });

  // 4) synthesize (consume the stream, parse for refusal + body)
  let accumulated = '';
  for await (const chunk of deps.synthesizer.synthesize({ utterance: question.q, sources })) {
    if (chunk.type === 'textDelta') accumulated += chunk.delta;
  }
  const parsed = parseSynthesisOutput(accumulated, sources.length);
  const result = scoreQuestion(question, retrieved, parsed.text, parsed.isRefusal);

  // 5) optional RAGAS metrics (judge calls; flag-gated)
  let scores: RagasScores | null = null;
  if (deps.judge !== null && !parsed.isRefusal) {
    scores = await scoreRagas(
      { question: question.q, answer: parsed.text, contexts: sources.map((s) => s.text) },
      deps.judge,
    );
  }

  return { result, scores };
}

async function main(): Promise<void> {
  const orgId = process.argv[2] ?? process.env.RISEZOME_EVAL_ORG_ID;
  if (orgId === undefined || orgId.length === 0) {
    console.error('Usage: tsx --env-file=.env eval/replay.ts <orgId>  (or set RISEZOME_EVAL_ORG_ID)');
    process.exit(1);
  }
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const metricsEnabled = process.env.RISEZOME_EVAL_METRICS === 'true' || process.argv.includes('--metrics');
  const deps = {
    db: createServiceClient(),
    embedder: new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') }),
    synthesizer: new AnthropicSynthesizer({ apiKey: anthropicKey }),
    orgId,
    judge: metricsEnabled ? makeAnthropicJudge({ apiKey: anthropicKey }) : null,
  };

  const questions = loadGoldenSet();
  const scored: ScoredResult[] = [];
  for (const q of questions) {
    process.stderr.write(`  replaying: ${q.q}\n`);
    scored.push(await replayOne(deps, q));
  }

  const results: QuestionResult[] = scored.map((s) => s.result);
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

  const allScores = scored.map((s) => s.scores).filter((s): s is RagasScores => s !== null);
  const ragasMean = allScores.length > 0 ? meanScores(allScores) : null;
  if (ragasMean !== null) {
    const fmt = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(2));
    process.stderr.write(
      `\n=== RAGAS (mean over ${String(allScores.length)} answered): ` +
        `faithfulness ${fmt(ragasMean.faithfulness)} · answer-relevancy ${fmt(ragasMean.answerRelevancy)} · ` +
        `context-precision ${fmt(ragasMean.contextPrecision)} · context-recall ${fmt(ragasMean.contextRecall)} ===\n`,
    );
  } else if (metricsEnabled) {
    process.stderr.write('\n=== RAGAS: no answered questions to score ===\n');
  }

  process.stdout.write(
    JSON.stringify({ ...summary, ragas: { mean: ragasMean, perQuestion: scored.map((s) => s.scores) } }, null, 2),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
