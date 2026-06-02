/**
 * Corpus eval replay runner (U1).
 *
 * Replays each labeled question in golden-questions.jsonl through the REAL
 * retrieval + synthesis path (embed -> hybridSearch -> dedupe -> parent-expand
 * -> synthesize -> verify -> score) and reports per-question pass/recall plus
 * the synthesized answer / refusal. The pipeline itself lives in
 * src/corpus-eval.ts (shared with the dev-page endpoints); this file is the CLI
 * wrapper + report formatting.
 *
 * SCOPE: this harness exercises the RAG/corpus path ONLY. It does NOT run the
 * router classifier or live skills (github_count, trello_count, ...), so it
 * cannot catch a skill-argument-misparse regression. Skill self-healing
 * regressions (the "open case issues" → bogus-label class) are gated by
 * deterministic unit tests instead — see test/skills/github/search_count.test.ts
 * and test/skills/trello/{count,by_member}.test.ts (per the eval-regression
 * convention: replay-skipped paths get unit tests). Extending replay to cover
 * the skill path is a known, deferred gap.
 *
 * Usage (from apps/bot-worker):
 *   pnpm tsx --env-file=.env eval/replay.ts <orgId> [--metrics]
 *   # or set RISEZOME_EVAL_ORG_ID
 *
 * Env: SUPABASE_URL, SUPABASE_SECRET_KEY, VOYAGE_API_KEY, ANTHROPIC_API_KEY.
 * Read-only against the corpus; no writes.
 */
import { VoyageEmbedder } from '@risezome/engine/embed';
import { AnthropicSynthesizer } from '@risezome/engine/synthesize';
import { makeAnthropicJudge, meanScores, type RagasScores } from '@risezome/engine/eval';
import { createServiceClient } from '../src/db.js';
import {
  evaluateQuestion,
  loadGoldenSet,
  summarize,
  type EvalDeps,
  type EvalQuestionView,
} from '../src/corpus-eval.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const orgId = process.argv[2] ?? process.env.RISEZOME_EVAL_ORG_ID;
  if (orgId === undefined || orgId.length === 0) {
    console.error('Usage: tsx --env-file=.env eval/replay.ts <orgId>  (or set RISEZOME_EVAL_ORG_ID)');
    process.exit(1);
  }
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const metricsEnabled = process.env.RISEZOME_EVAL_METRICS === 'true' || process.argv.includes('--metrics');
  const deps: EvalDeps = {
    db: createServiceClient(),
    embedder: new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') }),
    synthesizer: new AnthropicSynthesizer({ apiKey: anthropicKey }),
    orgId,
    judge: metricsEnabled ? makeAnthropicJudge({ apiKey: anthropicKey }) : null,
  };

  const views: EvalQuestionView[] = [];
  for (const q of loadGoldenSet()) {
    process.stderr.write(`  replaying: ${q.q}\n`);
    views.push(await evaluateQuestion(deps, q));
  }

  const summary = summarize(views.map((v) => v.result));
  process.stderr.write(
    `\n=== Corpus eval: ${String(summary.passed)}/${String(summary.total)} pass ` +
      `(${(summary.passRate * 100).toFixed(0)}%), mean recall ` +
      `${summary.meanRecall === null ? 'n/a' : summary.meanRecall.toFixed(2)} ===\n`,
  );
  for (const v of views) {
    const r = v.result;
    const mark = r.pass ? 'PASS' : 'FAIL';
    const recallStr = r.recall === null ? '—' : `${(r.recall * 100).toFixed(0)}%`;
    const tag = v.suppressed ? 'suppressed' : `refusal=${String(r.isRefusal)}`;
    process.stderr.write(
      `  [${mark}] recall=${recallStr} ${tag} :: ${r.q}\n` +
        (r.missed.length > 0 ? `         missed: ${r.missed.join(', ')}\n` : ''),
    );
  }

  const allScores = views.map((v) => v.ragas).filter((s): s is RagasScores => s !== null);
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
    JSON.stringify({ ...summary, ragas: { mean: ragasMean, perQuestion: views.map((v) => v.ragas) } }, null, 2),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
