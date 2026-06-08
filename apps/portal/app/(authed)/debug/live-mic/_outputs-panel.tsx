'use client';

import { type ReactElement, type ReactNode } from 'react';
import type { UtteranceTrace } from './_pipeline-model';
import type { OutcomeType } from './_pipeline-model';

/**
 * Tabbed Outputs panel for the Pipeline Trace Debug page (U4).
 *
 * Three tabs, deep-linked from the trace ledger's "view retrievals/synthesis"
 * buttons (via the selected tab lifted into _client, U5):
 *   - Retrievals — the selected utterance's ranked hits (distance / RRF / body).
 *   - Synthesis  — the real `SynthesisStream` (+ skill results), passed in as a
 *                  slot so this component stays decoupled from the HUD context
 *                  and reuses the production renderer (KTD5).
 *   - Trace JSON — the selected utterance's raw trace stages.
 */

export type OutputTab = 'retrievals' | 'synthesis' | 'json';

/** A ranked retrieval the panel renders (a subset of the client's CardEvent). */
export interface OutputCard {
  cardId: string;
  rank: number;
  title: string;
  source: string;
  docType: string;
  url?: string | null;
  snippet: string;
  body: string;
  distance?: number;
  score?: number;
  ftsMatched?: boolean;
  isSummary?: boolean;
}

const SRC_COLOR: Record<string, string> = {
  github: 'var(--color-src-github)',
  jira: 'var(--color-src-jira)',
  slack: 'var(--color-src-slack)',
  code: 'var(--color-src-code)',
};

function SrcPill({ kind }: { kind: string }): ReactElement {
  const c = SRC_COLOR[kind] ?? 'var(--color-src-default)';
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide"
      style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c }}
    >
      {kind}
    </span>
  );
}

function Empty({ label }: { label: string }): ReactElement {
  return (
    <div className="flex min-h-[200px] items-center justify-center p-8 text-center">
      <div className="max-w-[260px] text-[12.5px] italic leading-relaxed text-muted/70">{label}</div>
    </div>
  );
}

function RetrievalsTab({ cards, outcomeType }: { cards: OutputCard[]; outcomeType: OutcomeType }): ReactElement {
  if (cards.length === 0) {
    return (
      <Empty
        label={
          outcomeType === 'skip'
            ? 'No retrieval — gated before embed.'
            : 'No hits survived the relevance floor.'
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-[11.5px] text-muted">
        <span className="font-mono">{cards.length} hits</span>
        <span className="text-muted/70">· RRF-fused · reranked</span>
      </div>
      {cards.map((c) => {
        const top = c.rank === 1;
        return (
          <div
            key={c.cardId}
            className="rounded-[11px] border bg-card/40 px-3 py-2.5"
            style={{ borderColor: top ? 'color-mix(in srgb, var(--accent) 35%, var(--border))' : 'var(--border)' }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-[10px] text-muted/70">[{c.rank}]</span>
              <SrcPill kind={c.source} />
              <span className="text-[10px] text-muted/70">{c.docType}</span>
              {c.isSummary && (
                <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-accent">summary</span>
              )}
              {top && (
                <span className="ml-auto font-mono text-[9.5px] font-bold tracking-wide text-accent">TOP MATCH</span>
              )}
            </div>
            <div className="break-all font-mono text-[12px] leading-snug text-fg">{c.title}</div>
            <div className="mt-1.5 border-l-2 border-border pl-2 text-[11.5px] leading-relaxed text-muted">
              {c.snippet}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
              {c.distance !== undefined && (
                <Metric k="distance" v={c.distance.toFixed(3)} />
              )}
              {c.score !== undefined && <Metric k="RRF" v={c.score.toFixed(4)} />}
              <Metric k="body" v={`${c.body.length.toLocaleString()} ch`} />
              {c.ftsMatched && <Metric k="fts" v="✓" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Metric({ k, v }: { k: string; v: string }): ReactElement {
  return (
    <span className="text-[10.5px] text-muted/70">
      {k} <span className="font-mono text-muted">{v}</span>
    </span>
  );
}

function JsonTab({ trace }: { trace: UtteranceTrace | null }): ReactElement {
  if (!trace) return <Empty label="No trace for this utterance yet." />;
  const obj = {
    traceId: trace.traceId,
    utteranceId: trace.utteranceId,
    priorContext: trace.priorContext,
    stages: trace.stages.map((s) => ({
      stage: s.stage,
      status: s.status,
      latencyMs: s.latencyMs,
      ...(s.decision !== undefined ? { decision: s.decision } : {}),
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      ...(s.data !== undefined ? { data: s.data } : {}),
    })),
  };
  return (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">
      {JSON.stringify(obj, null, 2)}
    </pre>
  );
}

export function OutputsPanel({
  tab,
  onTab,
  cards,
  synthesis,
  synthesisCount,
  trace,
  outcomeType,
}: {
  tab: OutputTab;
  onTab: (tab: OutputTab) => void;
  cards: OutputCard[];
  /** The Synthesis tab content — the real SynthesisStream (+ skill results),
   *  passed as a slot so this panel reuses the production renderer (KTD5). */
  synthesis: ReactNode;
  synthesisCount: number;
  trace: UtteranceTrace | null;
  outcomeType: OutcomeType;
}): ReactElement {
  const tabs: { id: OutputTab; label: string; count?: number }[] = [
    { id: 'retrievals', label: 'Retrievals', count: cards.length },
    { id: 'synthesis', label: 'Synthesis', count: synthesisCount },
    { id: 'json', label: 'Trace JSON' },
  ];
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-0.5 border-b border-border">
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-2 text-[12.5px] ${
                on ? 'border-accent font-semibold text-fg' : 'border-transparent font-medium text-muted'
              }`}
            >
              {t.label}
              {t.count != null && <span className="font-mono text-[10px] text-muted/70">{t.count}</span>}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-3">
        {tab === 'retrievals' && <RetrievalsTab cards={cards} outcomeType={outcomeType} />}
        {tab === 'synthesis' && <div>{synthesis}</div>}
        {tab === 'json' && <JsonTab trace={trace} />}
      </div>
    </div>
  );
}
