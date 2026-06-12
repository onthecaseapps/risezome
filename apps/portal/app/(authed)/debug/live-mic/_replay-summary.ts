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
import {
  buildLedger,
  deriveOutcome,
  STATUS_LABEL,
  type StageRecord,
  type UtteranceTrace,
} from './_pipeline-model';

/** A retrieved card surfaced for an utterance (subset used in the summary). */
export interface ReplaySummaryCard {
  readonly rank: number;
  readonly source: string;
  readonly title: string;
  readonly score?: number;
  readonly distance?: number;
}

/** Per-utterance I/O the trace doesn't carry: the synthesized answer text and the
 *  retrieved cards (both live in the page's reducer, passed in for the full dump). */
export interface ReplayUtteranceOutput {
  readonly answer?: string;
  readonly cards?: readonly ReplaySummaryCard[];
}

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
    // status 'skipped' = the judge was NEVER ROUTED (question lane / strict
    // off / no classifier) — say so; the old fallback printed "judge ran".
    parts.push(
      judge.status === 'skipped'
        ? `judge not run (${judge.reason ?? 'not_routed'})`
        : judge.status === 'short_circuited'
          ? `judge SKIP (${judge.reason ?? 'n/a'})`
          : `judge ${judge.decision ?? 'ran'}`,
    );
  }
  return parts.length > 0 ? parts.join(' → ') : 'not recorded';
}

/** Derived per-utterance timeline: where the wall-clock went, anchored at
 *  pipeline entry (`@t+X` = offset). Judge shows its OWN duration plus how long
 *  the verdict was awaited; search splits RPC vs rerank when recorded; synthesis
 *  shows TTFT, when prose became user-visible, and when it finished. */
function timingLine(trace: UtteranceTrace): string | null {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const judge = findStage(trace, 'llm-judge');
  const embed = findStage(trace, 'embed');
  const search = findStage(trace, 'hybrid-search');
  const emit = findStage(trace, 'emit');
  const skill = findStage(trace, 'skill');
  const synth = findStage(trace, 'synthesis');
  const parts: string[] = [];
  if (judge !== undefined && judge.status !== 'skipped') {
    const awaited = num(judge.data?.['awaitedMs']);
    const extra = awaited !== undefined && awaited > judge.latencyMs ? `, awaited ${String(awaited)}ms` : '';
    parts.push(`judge ${String(judge.latencyMs)}ms${extra}`);
  }
  if (embed !== undefined) {
    const adapter = num(embed.data?.['adapterEmbedMs']);
    parts.push(`embed ${String(adapter ?? embed.latencyMs)}ms${adapter !== undefined ? ' (adapter)' : ''}`);
  }
  if (search !== undefined) {
    const rpc = num(search.data?.['rpcMs']);
    const rerank = num(search.data?.['rerankMs']);
    const split = [
      ...(rpc !== undefined ? [`rpc ${String(rpc)}ms`] : []),
      ...(rerank !== undefined ? [`rerank ${String(rerank)}ms`] : []),
    ];
    parts.push(`search ${String(search.latencyMs)}ms${split.length > 0 ? ` (${split.join(' + ')})` : ''}`);
  }
  if (emit !== undefined && emit.atMs !== undefined) {
    parts.push(`cards@t+${String(emit.atMs + emit.latencyMs)}ms`);
  }
  if (skill !== undefined) parts.push(`skill ${String(skill.latencyMs)}ms`);
  if (synth !== undefined) {
    const ttft = num(synth.data?.['ttftMs']);
    const firstProse = num(synth.data?.['firstProseMs']);
    if (ttft !== undefined) parts.push(`synth ttft ${String(ttft)}ms`);
    if (synth.atMs !== undefined && firstProse !== undefined) {
      parts.push(`first prose@t+${String(synth.atMs + firstProse)}ms`);
    }
    if (synth.atMs !== undefined) {
      parts.push(`synth done@t+${String(synth.atMs + synth.latencyMs)}ms`);
    }
  }
  return parts.length > 0 ? `timing: ${parts.join(' · ')}` : null;
}

/** Any stage that genuinely STOPPED the pipeline (skip/miss/ungrounded/refusal),
 *  so a suppressed utterance is never silently omitted. Excludes the question-
 *  lane heuristic-gate BYPASS: that's a short-circuit (the question lane skips
 *  the relevance gate) but NOT a suppression — the utterance proceeds and may
 *  ground, so reporting it as "suppressed at: heuristic-gate" is misleading. */
function suppressionLine(trace: UtteranceTrace): string | null {
  const stop = trace.stages.find(
    (s) =>
      (s.status === 'short_circuited' && s.decision !== 'bypassed') ||
      (s.stage === 'citation-verify' && s.decision === 'ungrounded'),
  );
  if (stop === undefined) return null;
  return `${stop.stage} — ${stop.decision ?? stop.status} (${stop.reason ?? 'n/a'})`;
}

/** The FULL gate-by-gate ledger (every stage that ran/decided), so a paste can
 *  be diagnosed without the live page. Uses the same ledger the trace panel
 *  renders; skips rows downstream of the terminal stop (notreached) to cut noise.
 *  Excludes raw vectors/embeddings — only decisions + counts/scores. */
function gateLedgerLines(trace: UtteranceTrace): string[] {
  const ledger = buildLedger(trace);
  const lines: string[] = ['gates:'];
  for (const row of ledger) {
    if (row.status === 'notreached') continue;
    // `@t+X` = the stage's START offset from pipeline entry — exposes parallel
    // overlap (judge ∥ embed ∥ search) that a flat duration list hides.
    const at = row.atMs != null ? ` @t+${String(row.atMs)}ms` : '';
    const ms = row.latencyMs != null ? ` (${String(row.latencyMs)}ms${at})` : '';
    let line = `  ${row.code} ${row.name} [${STATUS_LABEL[row.status]}] ${row.result}${ms}`;
    // Append data-bearing detail (counts/scores/etc.) that the one-line result
    // doesn't already carry — skip decision/reason (already in `result`) + the
    // bulky hits list.
    const extra = row.detail
      .filter(([k]) => k !== 'decision' && k !== 'reason' && k !== 'hits')
      .map(([k, v]) => `${k}=${v}`);
    if (extra.length > 0) line += ` · ${extra.join(', ')}`;
    lines.push(line);
  }
  return lines;
}

/** Truncate a long answer/body for the paste while keeping it legible. */
function clip(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}… (+${String(t.length - max)} chars)` : t;
}

function utteranceBlock(
  u: ReplayUtterance,
  index: number,
  trace: UtteranceTrace | undefined,
  output: ReplayUtteranceOutput | undefined,
): string {
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
  const timing = timingLine(trace);
  if (timing !== null) lines.push(timing);
  const supp = suppressionLine(trace);
  if (supp !== null) lines.push(`suppressed at: ${supp}`);

  const ctx = trace.priorContext;
  if (ctx.length === 0) {
    lines.push('prior context: none');
  } else {
    lines.push(`prior context (${String(ctx.length)}):`);
    for (const entry of ctx) lines.push(`  · ${entry}`);
  }

  // Full gate-by-gate ledger (every stage decision/reason/data).
  for (const line of gateLedgerLines(trace)) lines.push(line);

  // Retrieved cards (the I/O the trace doesn't carry).
  const cards = output?.cards ?? [];
  if (cards.length > 0) {
    lines.push(`retrieved cards (${String(cards.length)}):`);
    for (const c of cards) {
      const score = c.score !== undefined ? ` score=${c.score.toFixed(4)}` : '';
      const dist = c.distance !== undefined ? ` dist=${c.distance.toFixed(3)}` : '';
      lines.push(`  [${String(c.rank)}] ${c.source} · ${c.title}${score}${dist}`);
    }
  }

  // Synthesized answer text.
  if (output?.answer !== undefined && output.answer.trim().length > 0) {
    lines.push(`answer: ${clip(output.answer)}`);
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
  scope?: { scoped: boolean; meetingId: string | null } | null,
  outputsById?: ReadonlyMap<string, ReplayUtteranceOutput>,
): string {
  if (utterances.length === 0) {
    return '# Replay summary\n\nNo utterances were replayed.';
  }
  const blocks = utterances.map((u, i) =>
    utteranceBlock(u, i, tracesById.get(u.utteranceId), outputsById?.get(u.utteranceId)),
  );
  // U5: the resolved retrieval scope for this replay session (R6) — scoped to a
  // meeting's effective source set, or whole-org / unscoped for a file load.
  const scopeLine =
    scope !== undefined && scope !== null
      ? scope.scoped && scope.meetingId !== null
        ? `retrieval scope: scoped to meeting ${scope.meetingId}`
        : 'retrieval scope: unscoped (no meeting)'
      : null;
  return [
    `# Replay summary — ${String(utterances.length)} utterance${utterances.length === 1 ? '' : 's'}`,
    ...(scopeLine !== null ? [scopeLine] : []),
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
