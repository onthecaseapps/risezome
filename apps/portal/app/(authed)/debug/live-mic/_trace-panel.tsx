'use client';

import { type ReactElement, useState } from 'react';

/**
 * Per-utterance Pipeline Trace panel for the local-mic debug page (U3).
 *
 * The bot-worker dev sidecar emits a `trace` WS event per finalized utterance
 * (apps/bot-worker/src/pipeline/sink-ws.ts → the PipelineTrace from
 * pipeline/contract.ts). The client indexes those events by `utteranceId`
 * (`indexTrace`, now in _pipeline-model.ts) and renders the selected utterance's
 * full gate-by-gate journey here: a terminal-outcome banner + end-to-end latency
 * waterfall, a suppression-gate ribbon, and an expandable stage ledger.
 *
 * All display logic (the 16-row catalog, outcome/ledger/ribbon/waterfall
 * derivation) lives in _pipeline-model.ts; this file is presentation only.
 */

// ── Trace shapes + indexing live in _pipeline-model.ts (U2). Re-exported here
//    so existing callers (_client.tsx, tests) keep their import path. ────
export type {
  PipelineStage,
  StageStatus,
  StageRecord,
  TraceHit,
  TraceEvent,
  UtteranceTrace,
} from './_pipeline-model';
export { indexTrace } from './_pipeline-model';

import {
  buildLedger,
  deriveOutcome,
  gateRibbon,
  reachedCount,
  waterfallSegments,
  STATUS_COLORS,
  STATUS_LABEL,
  type DisplayStatus,
  type LedgerRow,
  type Outcome,
  type OutcomeType,
  type RibbonSegment,
  type UtteranceTrace,
} from './_pipeline-model';

/** A retrieved card the Outputs panel renders (kept here for back-compat; the
 *  Outputs/Retrievals tab consumes this shape). Structurally a subset of the
 *  client's CardEvent. */
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

// ── Rendering ──────────────────────────────────────────────────────────────

/** Banner accent for each terminal outcome (maps to a display status color). */
const OUTCOME_ACCENT: Record<OutcomeType, DisplayStatus> = {
  grounded: 'pass',
  miss: 'miss',
  ungrounded: 'miss',
  refusal: 'miss',
  skip: 'skip',
  pending: 'info',
};

function StatusGlyph({ status, size = 11 }: { status: DisplayStatus; size?: number }): ReactElement {
  const c = STATUS_COLORS[status];
  const p = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: c,
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (status) {
    case 'pass':
      return <svg {...p}><path d="M5 12.5l4.5 4.5L19 7" /></svg>;
    case 'miss':
      return <svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case 'skip':
      return <svg {...p}><path d="M12 4v6M12 14v6M5 12h14" /></svg>;
    case 'failopen':
      return <svg {...p}><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></svg>;
    default:
      return <svg {...p}><path d="M7 12h10" /></svg>;
  }
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(2);
}

function Waterfall({ ledger }: { ledger: LedgerRow[] }): ReactElement {
  const segs = waterfallSegments(ledger);
  return (
    <div>
      <div className="flex h-[7px] overflow-hidden rounded bg-white/5">
        {segs.map((s) => (
          <div
            key={s.id}
            title={`${s.name} · ${s.ms}ms`}
            style={{ width: `${s.pct}%`, background: STATUS_COLORS[s.status], opacity: 0.85 }}
            className="border-r border-bg last:border-r-0"
          />
        ))}
      </div>
      <div className="mt-[7px] flex flex-wrap gap-x-3 gap-y-1">
        {segs.filter((s) => s.labeled).map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5 text-[10.5px] text-muted">
            <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: STATUS_COLORS[s.status] }} />
            {s.name} <span className="font-mono text-muted/70">{s.ms}ms</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function OutcomeBanner({ outcome, ledger }: { outcome: Outcome; ledger: LedgerRow[] }): ReactElement {
  const accent = STATUS_COLORS[OUTCOME_ACCENT[outcome.type]];
  return (
    <div
      className="mb-4 overflow-hidden rounded-xl border"
      style={{ borderColor: `${accent}66`, background: `${accent}12` }}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div
          className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border"
          style={{ borderColor: accent, background: `${accent}2e` }}
        >
          <StatusGlyph status={OUTCOME_ACCENT[outcome.type]} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-fg">{outcome.headline}</span>
            {outcome.gap && (
              <span className="rounded-[5px] bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-300">
                → knowledge gap
              </span>
            )}
          </div>
          {outcome.sub && <div className="mt-0.5 text-[12.5px] text-muted">{outcome.sub}</div>}
        </div>
        <div className="flex-none text-right">
          <div className="font-mono text-[18px] font-semibold text-fg">{secs(outcome.ms)}s</div>
          <div className="text-[10px] uppercase tracking-wider text-muted/70">end-to-end</div>
        </div>
      </div>
      <div className="px-4 pb-3.5">
        <Waterfall ledger={ledger} />
      </div>
    </div>
  );
}

function GateRibbonView({ ribbon }: { ribbon: RibbonSegment[] }): ReactElement {
  return (
    <div className="mb-[18px] rounded-[11px] border border-border bg-card/40 px-3.5 py-2.5">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted/70">Suppression gates</div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {ribbon.map((g, i) => {
          const reached = g.status !== 'notreached';
          const c = STATUS_COLORS[g.status];
          return (
            <span key={g.id} className="inline-flex items-center">
              <span
                className="inline-flex items-center gap-1 font-mono text-[10px]"
                style={{ color: reached ? c : 'var(--muted)', opacity: reached ? 1 : 0.5, fontWeight: reached ? 600 : 400 }}
              >
                {g.label}
                <StatusGlyph status={g.status} size={9} />
              </span>
              {i < ribbon.length - 1 && <span className="ml-1.5 text-[10px] text-muted/50">›</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function LedgerRowView({
  row,
  isLast,
  expanded,
  onToggle,
  onOpenOutput,
}: {
  row: LedgerRow;
  isLast: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenOutput?: (tab: 'retrievals' | 'synthesis') => void;
}): ReactElement {
  const c = STATUS_COLORS[row.status];
  const reached = row.status !== 'notreached';
  const stop = row.status === 'skip' || row.status === 'miss';
  const hasDetail = row.detail.length > 0;
  return (
    <div className="flex gap-3">
      {/* spine + node */}
      <div className="flex w-[22px] flex-none flex-col items-center">
        <div
          className="z-10 flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full border-[1.5px]"
          style={{ borderColor: reached ? c : 'var(--border)', background: reached ? `${c}22` : 'transparent' }}
        >
          <StatusGlyph status={row.status} size={11} />
        </div>
        {!isLast && (
          <div
            className="mb-0.5 mt-0.5 min-h-[14px] w-0.5 flex-1"
            style={{ background: reached ? c : 'var(--border)', opacity: 0.45 }}
          />
        )}
      </div>

      {/* body */}
      <div className={`min-w-0 flex-1 ${isLast ? '' : 'pb-3'}`}>
        <button
          type="button"
          onClick={() => hasDetail && onToggle()}
          className="block w-full border-none bg-transparent p-0 text-left"
          style={{ cursor: hasDetail ? 'pointer' : 'default' }}
        >
          <div className="flex items-baseline gap-2">
            <span
              className="flex-none font-mono text-[10px] tracking-wide text-muted/70"
              style={{ opacity: reached ? 1 : 0.55 }}
            >
              {row.code}
            </span>
            <span className={`text-[13.5px] font-semibold ${reached ? 'text-fg' : 'text-muted/70'}`}>{row.name}</span>
            {row.latencyMs != null && (
              <span className="flex-none font-mono text-[10.5px] text-muted/70">{row.latencyMs}ms</span>
            )}
            <span
              className="ml-auto flex-none rounded-[5px] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide"
              style={{ background: reached ? `${c}24` : 'transparent', color: reached ? c : 'var(--muted)' }}
            >
              {STATUS_LABEL[row.status]}
            </span>
            {hasDetail && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-none text-muted/70 transition-transform"
                style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            )}
          </div>
          <div className="ml-[19px] mt-0.5 text-[11.5px] text-muted/70">{row.engine}</div>
          <div
            className="ml-[19px] mt-1 text-[12.5px] leading-snug"
            style={{ color: reached ? (stop ? c : 'var(--muted)') : 'var(--muted)', fontWeight: stop ? 500 : 400 }}
          >
            {row.result}
          </div>
        </button>

        {expanded && hasDetail && (
          <div className="ml-[19px] mt-2 overflow-hidden rounded-[9px] border border-border bg-bg/40">
            {row.detail.map(([k, v], i) => (
              <div
                key={`${k}-${i}`}
                className={`flex gap-3 px-3 py-1.5 ${i < row.detail.length - 1 ? 'border-b border-border' : ''}`}
              >
                <span className="flex-[0_0_38%] font-mono text-[11.5px] text-muted/70">{k}</span>
                <span className="flex-1 break-words text-right font-mono text-[11.5px] text-muted">{v}</span>
              </div>
            ))}
            {row.outputsLink && reached && onOpenOutput && (
              <button
                type="button"
                onClick={() => onOpenOutput(row.outputsLink!)}
                className="flex w-full items-center justify-end gap-1.5 border-t border-border bg-transparent px-3 py-2 text-[11.5px] font-semibold text-accent"
              >
                view {row.outputsLink}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }): ReactElement {
  return (
    <div className="flex min-h-[200px] items-center justify-center p-8 text-center">
      <div className="max-w-[260px] text-[12.5px] italic leading-relaxed text-muted/70">{label}</div>
    </div>
  );
}

export function TracePanel({
  trace,
  utteranceText,
  onOpenOutput,
}: {
  trace: UtteranceTrace | null;
  utteranceText: string | null;
  onOpenOutput?: (tab: 'retrievals' | 'synthesis') => void;
  /** @deprecated retained for back-compat; the ledger renders the trace's own
   *  self-contained hits. Cards now live in the Outputs panel. */
  cards?: TraceCard[];
}): ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!trace) {
    return (
      <Empty
        label={
          utteranceText === null
            ? 'Select an utterance to see its full pipeline trace.'
            : 'No trace yet for this utterance — gated/skipped lines and in-flight retrievals trace as they complete.'
        }
      />
    );
  }

  const ledger = buildLedger(trace);
  const outcome = deriveOutcome(trace);
  const ribbon = gateRibbon(ledger);
  const reached = reachedCount(ledger);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <OutcomeBanner outcome={outcome} ledger={ledger} />
      <GateRibbonView ribbon={ribbon} />
      <div className="mb-3 text-[10px] font-bold uppercase tracking-wider text-muted/70">
        Stage ledger · {reached} / {ledger.length} reached
      </div>
      <div>
        {ledger.map((row, i) => (
          <LedgerRowView
            key={row.id}
            row={row}
            isLast={i === ledger.length - 1}
            expanded={expanded.has(row.id)}
            onToggle={() => toggle(row.id)}
            {...(onOpenOutput ? { onOpenOutput } : {})}
          />
        ))}
      </div>
    </div>
  );
}
