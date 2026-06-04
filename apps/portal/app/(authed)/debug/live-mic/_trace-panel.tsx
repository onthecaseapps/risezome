'use client';

import { type ReactElement, type ReactNode } from 'react';

/**
 * Per-utterance, stage-by-stage trace view for the local-mic debug page (U5).
 *
 * The bot-worker dev sidecar emits a `trace` WS event per finalized utterance
 * (apps/bot-worker/src/pipeline/sink-ws.ts → the PipelineTrace from
 * pipeline/contract.ts). The client indexes those events by `utteranceId`
 * (see `indexTrace` below) and renders the selected utterance's trace here:
 * the ordered stages, a ran/skip/short-circuit badge each, the WHY (reason),
 * latency, and an expandable per-stage data payload.
 *
 * NOTE — the `trace` event's hybrid-search stage data only carries a hit
 * COUNT (`data.hits`), not the retrieved cards/scores. The retrieved cards
 * arrive as separate `card` events (keyed by traceId/utteranceId), so the
 * panel takes them as a prop (`cards`) rather than reading them off the stage
 * record. See the follow-up note in U5's report for the sink enrichments the
 * panel would otherwise want inline.
 */

// ── Trace shapes mirrored from apps/bot-worker/src/pipeline/contract.ts ────
// (The client already mirrors WS event shapes with local interfaces; this
//  follows that pattern — the StageRecord / PipelineTrace shape verbatim.)

export type PipelineStage =
  | 'heuristic-gate'
  | 'llm-judge'
  | 'embed'
  | 'hybrid-search'
  | 'crag'
  | 'dedup-expand'
  | 'synthesis'
  | 'citation-verify';

export type StageStatus = 'ran' | 'skipped' | 'short_circuited';

export interface StageRecord {
  stage: PipelineStage;
  status: StageStatus;
  /** The decision the stage reached (e.g. 'surface', 'skip', 'answer'). */
  decision?: string;
  /** Why — the explanation string surfaced on this panel. */
  reason?: string;
  latencyMs: number;
  /** Stage-specific structured payload (hit counts, confidence, citation
   *  breakdown, …). */
  data?: Record<string, unknown>;
}

/** The `trace` WS event payload (the PipelineTrace, plus the `type` tag). */
export interface TraceEvent {
  type: 'trace';
  traceId: string;
  utteranceId: string;
  meetingId: string;
  stages: StageRecord[];
}

/** What the client stores per utterance (the trace minus the `type` tag). */
export interface UtteranceTrace {
  traceId: string;
  utteranceId: string;
  meetingId: string;
  stages: StageRecord[];
}

// ── Trace indexing (testable, transport-free) ──────────────────────────────

/**
 * Fold a `trace` event into the per-utterance index. Pure + immutable so it's
 * trivially testable (U5's light test): a `trace` event is stored under its
 * `utteranceId`; a later trace for the same utterance replaces the prior one
 * (the latest run wins — utterances are re-traced on revision).
 */
export function indexTrace(
  prev: Map<string, UtteranceTrace>,
  evt: TraceEvent,
): Map<string, UtteranceTrace> {
  const next = new Map(prev);
  next.set(evt.utteranceId, {
    traceId: evt.traceId,
    utteranceId: evt.utteranceId,
    meetingId: evt.meetingId,
    stages: evt.stages,
  });
  return next;
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** The canonical stage order (so a partially-run trace still reads top-down
 *  in pipeline order even if events arrive interleaved). */
const STAGE_ORDER: PipelineStage[] = [
  'heuristic-gate',
  'llm-judge',
  'embed',
  'hybrid-search',
  'crag',
  'dedup-expand',
  'synthesis',
  'citation-verify',
];

const STAGE_LABEL: Record<PipelineStage, string> = {
  'heuristic-gate': 'Heuristic gate',
  'llm-judge': 'LLM judge',
  embed: 'Embed',
  'hybrid-search': 'Hybrid search',
  crag: 'CRAG',
  'dedup-expand': 'Dedup + parent-expand',
  synthesis: 'Synthesis',
  'citation-verify': 'Citation verify',
};

/** A retrieved card the panel renders inline under hybrid-search (the cards
 *  arrive via `card` events, not the trace stage data). Structurally a subset
 *  of the client's CardEvent. */
export interface TraceCard {
  rank: number;
  title: string;
  source: string;
  docType: string;
  distance?: number;
  score?: number;
  ftsMatched?: boolean;
  isSummary?: boolean;
}

function StatusBadge({ status }: { status: StageStatus }): ReactElement {
  const cls =
    status === 'ran'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
      : status === 'skipped'
        ? 'bg-white/5 text-muted border-border'
        : 'bg-rose-500/15 text-rose-300 border-rose-500/40'; // short_circuited
  const label = status === 'short_circuited' ? 'short-circuit' : status;
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  );
}

function num(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' ? v : null;
}

/** Render the stage-specific "what happened" detail line. Mirrors the field
 *  set the core writes into each stage's `data` (see pipeline/core.ts). */
function StageDetail({ rec, cards }: { rec: StageRecord; cards: TraceCard[] }): ReactElement | null {
  const d = rec.data;

  if (rec.stage === 'heuristic-gate' || rec.stage === 'llm-judge') {
    const confidence = num(d, 'confidence');
    return (
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        {rec.decision !== undefined && (
          <span>
            decision <span className="text-fg">{rec.decision}</span>
          </span>
        )}
        {confidence !== null && (
          <span>
            confidence <span className="text-fg">{confidence.toFixed(2)}</span>
          </span>
        )}
      </div>
    );
  }

  if (rec.stage === 'embed') {
    const dims = num(d, 'dims');
    return dims !== null ? <span className="text-[11px] text-muted">{dims} dims</span> : null;
  }

  if (rec.stage === 'hybrid-search') {
    const hits = num(d, 'hits');
    return (
      <div className="space-y-1">
        <div className="text-[11px] text-muted">
          {hits !== null ? `${hits} hit(s)` : 'searched'}
        </div>
        {cards.length > 0 && (
          <ol className="space-y-1">
            {cards
              .slice()
              .sort((a, b) => a.rank - b.rank)
              .map((c) => (
                <li key={`${String(c.rank)}-${c.title}`} className="border-l-2 border-border pl-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-accent">[{String(c.rank)}]</span>
                    <span className="text-[11px] font-medium">{c.title}</span>
                    {c.isSummary === true && (
                      <span className="rounded border border-accent/40 bg-accent/10 px-1 text-[9px] font-semibold uppercase tracking-wider text-accent">
                        summary
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted">
                    {c.source} · {c.docType} ·{' '}
                    {c.distance !== undefined
                      ? `dist ${c.distance.toFixed(3)}`
                      : `rrf ${(c.score ?? 0).toFixed(4)}`}
                    {c.ftsMatched === true ? ' · fts' : ''}
                  </div>
                </li>
              ))}
          </ol>
        )}
      </div>
    );
  }

  if (rec.stage === 'crag') {
    const hits = num(d, 'hits');
    return (
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        {rec.decision !== undefined && (
          <span>
            decision <span className="text-fg">{rec.decision}</span>
          </span>
        )}
        {hits !== null && <span>{hits} hit(s) after</span>}
      </div>
    );
  }

  if (rec.stage === 'dedup-expand') {
    const surviving = num(d, 'surviving');
    const parentDoc = d?.parentDoc;
    return (
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        {surviving !== null && (
          <span>
            <span className="text-fg">{surviving}</span> surviving doc(s)
          </span>
        )}
        <span>parent-expand {parentDoc === true ? 'on' : 'off'}</span>
      </div>
    );
  }

  if (rec.stage === 'synthesis') {
    // decision: 'answer' | 'refusal' | 'ungrounded' | 'errored'
    const citations = num(d, 'citations');
    const status =
      rec.decision === 'answer'
        ? 'answer'
        : rec.decision === 'refusal'
          ? 'no_relevant_context'
          : (rec.decision ?? 'unknown');
    const tone =
      rec.decision === 'answer' ? 'text-emerald-300' : rec.decision === 'errored' ? 'text-rose-300' : 'text-amber-300';
    return (
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        <span>
          STATUS <span className={`font-semibold ${tone}`}>{status}</span>
        </span>
        {citations !== null && (
          <span>
            <span className="text-fg">{citations}</span> citation(s)
          </span>
        )}
      </div>
    );
  }

  if (rec.stage === 'citation-verify') {
    const total = num(d, 'total');
    const surviving = num(d, 'surviving');
    const dropped = num(d, 'dropped');
    const downgraded = num(d, 'downgraded');
    return (
      <div className="flex flex-wrap gap-x-3 text-[11px] text-muted">
        {surviving !== null && total !== null && (
          <span>
            <span className="text-emerald-300">{surviving}</span>/{total} verified
          </span>
        )}
        {downgraded !== null && downgraded > 0 && (
          <span className="text-amber-300">{downgraded} downgraded</span>
        )}
        {dropped !== null && dropped > 0 && <span className="text-rose-300">{dropped} dropped</span>}
      </div>
    );
  }

  return null;
}

function StageRow({ rec, cards }: { rec: StageRecord; cards: TraceCard[] }): ReactElement {
  const detail = <StageDetail rec={rec} cards={rec.stage === 'hybrid-search' ? cards : []} />;
  return (
    <li className="rounded border border-border bg-card p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={rec.status} />
        <span className="text-[12px] font-medium">{STAGE_LABEL[rec.stage]}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">{rec.latencyMs.toFixed(0)}ms</span>
      </div>
      {rec.reason !== undefined && (
        <div className="mt-1 text-[11px] text-muted">
          why: <span className="text-fg/90">{rec.reason}</span>
        </div>
      )}
      {detail !== null && <div className="mt-1.5">{detail}</div>}
      {rec.data !== undefined && Object.keys(rec.data).length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted hover:text-fg">
            raw data
          </summary>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-code-bg p-1.5 font-mono text-[10px] leading-relaxed">
            {JSON.stringify(rec.data, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

/** Order the stages canonically; keep any unknown extras at the end. */
function orderedStages(stages: StageRecord[]): StageRecord[] {
  const rank = (s: PipelineStage): number => {
    const i = STAGE_ORDER.indexOf(s);
    return i === -1 ? STAGE_ORDER.length : i;
  };
  return stages.slice().sort((a, b) => rank(a.stage) - rank(b.stage));
}

export function TracePanel({
  trace,
  cards,
  utteranceText,
}: {
  /** The selected utterance's trace, or null when none has arrived yet. */
  trace: UtteranceTrace | null;
  /** Cards retrieved for this utterance (from `card` events) — rendered
   *  inline under hybrid-search since the stage data carries only a count. */
  cards: TraceCard[];
  /** The selected utterance text, for the panel header. */
  utteranceText: string | null;
}): ReactElement {
  if (trace === null) {
    return (
      <Wrap>
        <Empty utteranceText={utteranceText} />
      </Wrap>
    );
  }

  const totalMs = trace.stages.reduce((sum, s) => sum + s.latencyMs, 0);
  const ordered = orderedStages(trace.stages);

  return (
    <Wrap>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-[10px] uppercase tracking-wider text-muted">trace</span>
        <span className="font-mono text-[10px] text-muted">{trace.traceId.slice(-6)}</span>
        <span className="ml-auto font-mono text-[10px] text-muted">
          {ordered.length} stage(s) · {totalMs.toFixed(0)}ms
        </span>
      </div>
      {utteranceText !== null && (
        <p className="mb-2 rounded border border-border bg-card/40 px-2 py-1 text-[11px] text-fg/90">
          {utteranceText}
        </p>
      )}
      <ol className="space-y-1.5">
        {ordered.map((rec, i) => (
          <StageRow key={`${rec.stage}-${String(i)}`} rec={rec} cards={cards} />
        ))}
      </ol>
    </Wrap>
  );
}

function Wrap({ children }: { children: ReactNode }): ReactElement {
  return <div className="text-sm">{children}</div>;
}

function Empty({ utteranceText }: { utteranceText: string | null }): ReactElement {
  return (
    <div className="rounded border border-dashed border-border px-4 py-8 text-center text-xs italic text-muted">
      {utteranceText === null
        ? 'Click a final transcript line to see its stage-by-stage pipeline trace.'
        : 'No trace yet for this utterance — gated/skipped lines and in-flight retrievals trace as they complete.'}
    </div>
  );
}
