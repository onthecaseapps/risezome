/**
 * Replay summary serializer (U5). Pure + React-free: turn an ordered replay
 * (the utterances that were sent) plus the indexed per-utterance traces into one
 * structured, LLM-pasteable text dump — every utterance with its terminal
 * outcome, skill-vs-RAG route + reason, the key gate decisions, and the exact
 * prior context the synthesizer saw (KTD6).
 *
 * Diagnostic, not exhaustive: decisions + I/O, never raw vectors/embeddings.
 * The copied text must be enough to diagnose a routing/dedup bug WITHOUT the
 * live meeting (R6) — so the route reason and prior context are always present,
 * and a gated/suppressed utterance is still listed with WHY it stopped (never
 * silently dropped).
 */
import type { ReplayUtterance } from './_replay-source';
import { deriveOutcome, type StageRecord, type UtteranceTrace } from './_pipeline-model';

/** mm:ss for a startMs offset (the same clock the file format uses). */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}:${s < 10 ? '0' : ''}${String(s)}`;
}

function findStage(trace: UtteranceTrace, stage: StageRecord['stage']): StageRecord | undefined {
  return trace.stages.find((s) => s.stage === stage);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** One-line skill-vs-RAG route summary from the router + skill stages. */
function routeLine(trace: UtteranceTrace): string {
  const router = findStage(trace, 'router');
  const skill = findStage(trace, 'skill');
  if (skill === undefined) {
    // Router never reached the collect/skill step (gated before, or not fired).
    if (router?.decision === 'not_fired') return `RAG — router not fired (${router.reason ?? 'n/a'})`;
    return 'RAG — no skill stage (gated before router collect)';
  }
  const intent = str(skill.data?.['intent']);
  const skillName = str(skill.data?.['skillName']);
  const reason = skill.reason ?? skill.decision ?? 'n/a';
  if (skillName !== undefined) {
    return `SKILL ${skillName} — ${skill.decision ?? 'n/a'} (${reason})`;
  }
  if (intent === 'rag') return `RAG — router chose rag (${reason})`;
  return `RAG — ${reason}`;
}

/** Relevance gate one-liner (merged heuristic + judge). */
function relevanceLine(trace: UtteranceTrace): string {
  const heur = findStage(trace, 'heuristic-gate');
  const judge = findStage(trace, 'llm-judge');
  const parts: string[] = [];
  if (heur) parts.push(`heuristic ${heur.decision ?? heur.reason ?? 'ran'}`);
  if (judge) {
    parts.push(judge.status === 'short_circuited' ? `judge SKIP (${judge.reason ?? 'n/a'})` : `judge ${judge.decision ?? 'ran'}`);
  }
  return parts.length > 0 ? parts.join(' → ') : 'not recorded';
}

/** Any stage that stopped the pipeline (skip/miss/ungrounded/refusal), so a
 *  suppressed utterance is never silently omitted. */
function suppressionLine(trace: UtteranceTrace): string | null {
  const stop = trace.stages.find(
    (s) => s.status === 'short_circuited' || (s.stage === 'citation-verify' && s.decision === 'ungrounded'),
  );
  if (stop === undefined) return null;
  return `${stop.stage} — ${stop.decision ?? stop.status} (${stop.reason ?? 'n/a'})`;
}

function utteranceBlock(u: ReplayUtterance, index: number, trace: UtteranceTrace | undefined): string {
  const who = u.speaker !== null ? u.speaker : 'unknown';
  const head = `[${String(index + 1)}] ${who} @ ${clock(u.startMs)}`;
  const lines = [head, `text: ${u.text}`];

  if (trace === undefined) {
    lines.push('outcome: (no trace — not sent through the pipeline, or gated before tracing)');
    return lines.join('\n');
  }

  const outcome = deriveOutcome(trace);
  lines.push(`outcome: ${outcome.type} — ${outcome.headline}${outcome.sub ? ` · ${outcome.sub}` : ''} (${String(outcome.ms)}ms)`);
  lines.push(`route: ${routeLine(trace)}`);
  lines.push(`relevance: ${relevanceLine(trace)}`);
  const supp = suppressionLine(trace);
  if (supp !== null) lines.push(`suppressed at: ${supp}`);

  const ctx = trace.priorContext;
  if (ctx.length === 0) {
    lines.push('prior context: none');
  } else {
    lines.push(`prior context (${String(ctx.length)}):`);
    for (const entry of ctx) lines.push(`  · ${entry}`);
  }
  return lines.join('\n');
}

/**
 * Serialize the whole replay to a structured text dump. `tracesById` is the
 * client's `indexTrace` map (utteranceId → trace); an utterance with no trace
 * is still listed (it was sent but produced no trace, e.g. gated pre-trace).
 */
export function formatReplaySummary(
  utterances: readonly ReplayUtterance[],
  tracesById: ReadonlyMap<string, UtteranceTrace>,
): string {
  if (utterances.length === 0) {
    return '# Replay summary\n\nNo utterances were replayed.';
  }
  const blocks = utterances.map((u, i) => utteranceBlock(u, i, tracesById.get(u.utteranceId)));
  return [
    `# Replay summary — ${String(utterances.length)} utterance${utterances.length === 1 ? '' : 's'}`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
