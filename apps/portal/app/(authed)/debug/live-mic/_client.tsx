'use client';

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

/**
 * Client component for the local-mic debug page. Opens a WebSocket to
 * the bot-worker's /local-debug endpoint, renders the live event
 * stream (utterances, retrieval cards, synthesis).
 *
 * Layout is debug-focused — three vertical columns showing each
 * pipeline stage side-by-side so a prompt-iteration session can
 * visually verify what the system is doing without scrolling.
 */

interface UtteranceEvent {
  type: 'utterance';
  text: string;
  isFinal: boolean;
  utteranceId: string;
  revision: number;
  at: number;
}

interface CardEvent {
  type: 'card';
  traceId: string;
  utteranceId: string;
  cardId: string;
  rank: number;
  docId: string;
  title: string;
  source: string;
  docType: string;
  url: string | null;
  snippet: string;
  body: string;
  distance: number;
}

interface SynthesisCitation {
  rank: number;
  cardId: string;
  position: number;
  quote?: string;
}

interface SynthesisStartEvent {
  type: 'synthesisStart';
  synthesisId: string;
  sourceCardIds: string[];
  traceId: string;
  utteranceId: string;
  /** When present, the page should REPLACE the prior synthesis card
   *  with this one (same topic, refined question). When absent, the
   *  new synthesis stands alone as a new card. */
  replacesSynthesisId?: string;
}

interface SynthesisDeltaEvent {
  type: 'synthesisDelta';
  synthesisId: string;
  delta: string;
}

interface SynthesisDoneEvent {
  type: 'synthesisDone' | 'synthesisRefusal';
  synthesisId: string;
  stopReason: string;
  accumulatedText: string;
  citations: SynthesisCitation[];
  usage?: Record<string, unknown>;
}

interface RetrievalSkipEvent {
  type: 'retrieval-skip';
  reason: string;
  traceId?: string;
  detail?: string;
}

interface OtherEvent {
  type: string;
  [k: string]: unknown;
}

interface SynthesisAbortedEvent {
  type: 'synthesisAborted';
  synthesisId: string;
  reason: string;
}

type DebugEvent =
  | UtteranceEvent
  | CardEvent
  | SynthesisStartEvent
  | SynthesisDeltaEvent
  | SynthesisDoneEvent
  | SynthesisAbortedEvent
  | RetrievalSkipEvent
  | OtherEvent;

interface SynthesisRecord {
  synthesisId: string;
  text: string;
  streaming: boolean;
  citations: SynthesisCitation[];
  refused: boolean;
  aborted: boolean;
  utteranceId: string;
}

interface CardGroup {
  utteranceId: string;
  traceId: string;
  cards: CardEvent[];
}

export function LiveMicDebugClient({
  wsUrl,
  orgId,
}: {
  wsUrl: string;
  orgId: string;
}): ReactElement {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'errored'>(
    'idle',
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<UtteranceEvent[]>([]);
  const [cardGroups, setCardGroups] = useState<CardGroup[]>([]);
  const [syntheses, setSyntheses] = useState<SynthesisRecord[]>([]);
  const [systemEvents, setSystemEvents] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const handleEvent = useCallback((evt: DebugEvent) => {
    switch (evt.type) {
      case 'utterance': {
        const u = evt as UtteranceEvent;
        setUtterances((prev) => {
          // Merge same-utteranceId revisions: replace prior partial with newer.
          const idx = prev.findIndex((p) => p.utteranceId === u.utteranceId);
          if (idx === -1) return [...prev, u].slice(-100);
          const copy = prev.slice();
          copy[idx] = u;
          return copy;
        });
        return;
      }
      case 'card': {
        const c = evt as CardEvent;
        setCardGroups((prev) => {
          const idx = prev.findIndex((g) => g.traceId === c.traceId);
          if (idx === -1) {
            return [
              ...prev,
              { utteranceId: c.utteranceId, traceId: c.traceId, cards: [c] },
            ].slice(-10);
          }
          const copy = prev.slice();
          copy[idx] = { ...copy[idx]!, cards: [...copy[idx]!.cards, c] };
          return copy;
        });
        return;
      }
      case 'synthesisStart': {
        const s = evt as SynthesisStartEvent;
        setSyntheses((prev) => {
          // When the bot-worker signals this synthesis REPLACES a
          // prior one (same topic, refined question — Jaccard overlap
          // ≥0.5 on source cardIds + within the replacement window),
          // swap in place rather than stacking. Keeps the page from
          // accumulating a card per partial-utterance refinement.
          const next: SynthesisRecord = {
            synthesisId: s.synthesisId,
            text: '',
            streaming: true,
            citations: [],
            refused: false,
            aborted: false,
            utteranceId: s.utteranceId,
          };
          if (s.replacesSynthesisId !== undefined) {
            const idx = prev.findIndex((p) => p.synthesisId === s.replacesSynthesisId);
            if (idx !== -1) {
              const copy = prev.slice();
              copy[idx] = next;
              return copy;
            }
          }
          return [...prev, next].slice(-10);
        });
        return;
      }
      case 'synthesisAborted': {
        const a = evt as SynthesisAbortedEvent;
        setSyntheses((prev) =>
          prev.map((s) =>
            s.synthesisId === a.synthesisId
              ? { ...s, streaming: false, aborted: true }
              : s,
          ),
        );
        return;
      }
      case 'synthesisDelta': {
        const d = evt as SynthesisDeltaEvent;
        setSyntheses((prev) =>
          prev.map((s) =>
            s.synthesisId === d.synthesisId ? { ...s, text: s.text + d.delta } : s,
          ),
        );
        return;
      }
      case 'synthesisDone':
      case 'synthesisRefusal': {
        const d = evt as SynthesisDoneEvent;
        setSyntheses((prev) =>
          prev.map((s) =>
            s.synthesisId === d.synthesisId
              ? {
                  ...s,
                  streaming: false,
                  text: d.accumulatedText,
                  citations: d.citations,
                  refused: d.type === 'synthesisRefusal',
                }
              : s,
          ),
        );
        return;
      }
      default: {
        const label =
          'reason' in evt
            ? `${evt.type}: ${String((evt as RetrievalSkipEvent).reason)}`
            : 'message' in evt
              ? `${evt.type}: ${String((evt as unknown as { message: string }).message)}`
              : evt.type;
        setSystemEvents((prev) => [...prev, `${new Date().toLocaleTimeString()} · ${label}`].slice(-50));
      }
    }
  }, []);

  const start = useCallback(() => {
    if (wsRef.current !== null) return;
    setStatus('connecting');
    setStatusMessage(null);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setStatus('connected');
      setStatusMessage('WebSocket open, waiting for sidecar…');
    });
    ws.addEventListener('message', (m) => {
      try {
        const evt = JSON.parse(m.data as string) as DebugEvent;
        handleEvent(evt);
      } catch (e) {
        setSystemEvents((prev) => [...prev, `parse error: ${String(e)}`].slice(-50));
      }
    });
    ws.addEventListener('close', () => {
      setStatus('closed');
      setStatusMessage('Closed');
      wsRef.current = null;
    });
    ws.addEventListener('error', () => {
      setStatus('errored');
      setStatusMessage('WebSocket error');
    });
  }, [wsUrl, handleEvent]);

  const stop = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  // Tear down on unmount so navigating away kills the sidecar.
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const reset = useCallback(() => {
    setUtterances([]);
    setCardGroups([]);
    setSyntheses([]);
    setSystemEvents([]);
  }, []);

  return (
    <div className="flex h-dvh flex-col px-6 py-6">
      <header className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Local-mic debug</h1>
          <p className="mt-0.5 text-xs text-muted">
            Sidecar → Deepgram → retrieval + synthesis, streamed to this page.
            Org <span className="text-fg">{orgId}</span> ·{' '}
            <span
              className={
                status === 'connected'
                  ? 'text-emerald-400'
                  : status === 'errored'
                    ? 'text-rose-400'
                    : 'text-muted'
              }
            >
              {status}
              {statusMessage !== null ? ` — ${statusMessage}` : ''}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {status !== 'connected' && status !== 'connecting' ? (
            <button
              type="button"
              onClick={start}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-press"
            >
              Start session
            </button>
          ) : (
            <button
              type="button"
              onClick={stop}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent-soft"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted hover:text-fg"
          >
            Clear
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-4">
        <Panel title={`Utterances (${utterances.length})`}>
          {utterances.length === 0 ? (
            <EmptyHint text="Start a session and start speaking. Partials appear as they stream; finals trigger retrieval." />
          ) : (
            <ul className="space-y-2 text-sm">
              {utterances.slice().reverse().map((u) => (
                <li
                  key={`${u.utteranceId}-${String(u.revision)}`}
                  className={
                    u.isFinal
                      ? 'rounded border border-border bg-card px-3 py-2'
                      : 'rounded border border-dashed border-border px-3 py-2 italic text-muted'
                  }
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted">
                    {u.isFinal ? 'final' : 'partial'} · rev {String(u.revision)} ·{' '}
                    {u.utteranceId.slice(-6)}
                  </div>
                  <div className="mt-0.5">{u.text}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Retrievals (${cardGroups.length})`}>
          {cardGroups.length === 0 ? (
            <EmptyHint text="Per-utterance retrieval results land here. Top hits ranked by vector distance." />
          ) : (
            <ul className="space-y-3 text-xs">
              {cardGroups.slice().reverse().map((g) => (
                <li key={g.traceId} className="rounded border border-border bg-card p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted">
                    {g.traceId.slice(-6)} · {String(g.cards.length)} hit(s)
                  </div>
                  <ol className="mt-1 space-y-2">
                    {g.cards.map((c) => (
                      <li key={c.cardId} className="border-l-2 border-border pl-2">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-[10px] text-muted">
                            [{String(c.rank)}]
                          </span>
                          <span className="text-[11px] font-medium">{c.title}</span>
                        </div>
                        <div className="text-[10px] text-muted">
                          {c.source} · {c.docType} · distance {c.distance.toFixed(3)}
                        </div>
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[10px] text-muted hover:text-fg">
                            body ({String(c.body.length)} chars)
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-code-bg p-1 font-mono text-[10px] leading-relaxed">
                            {c.body}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Syntheses (${syntheses.length})`}>
          {syntheses.length === 0 ? (
            <EmptyHint text='Synthesis answers stream here. Citations parse from the [N: "quote"] format.' />
          ) : (
            <ul className="space-y-3 text-sm">
              {syntheses.slice().reverse().map((s) => (
                <li
                  key={s.synthesisId}
                  className={
                    s.refused
                      ? 'rounded border border-rose-400/40 bg-rose-500/10 p-3'
                      : s.aborted
                        ? 'rounded border border-dashed border-border bg-card/40 p-3 opacity-60'
                        : 'rounded border border-border bg-card p-3'
                  }
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted">
                    {s.synthesisId.slice(-6)}
                    {s.streaming
                      ? ' · streaming'
                      : s.aborted
                        ? ' · superseded'
                        : s.refused
                          ? ' · refused'
                          : ' · done'}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-sm">
                    {s.text || (s.streaming ? '…' : '(empty)')}
                    {s.streaming && <span className="ml-1 animate-pulse">▊</span>}
                  </div>
                  {s.citations.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-muted">
                        Citations
                      </div>
                      <ol className="space-y-1 text-xs">
                        {s.citations.map((c, i) => (
                          <li
                            key={`${s.synthesisId}-${String(i)}`}
                            className="border-l-2 border-accent pl-2"
                          >
                            <span className="font-mono text-[10px] text-muted">
                              [{String(c.rank)}] pos {String(c.position)} ·{' '}
                              {c.cardId.slice(-6)}
                            </span>
                            {c.quote !== undefined && (
                              <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[10px]">
                                &ldquo;{c.quote}&rdquo;
                              </pre>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {systemEvents.length > 0 && (
        <footer className="mt-3 max-h-32 overflow-y-auto rounded border border-border bg-card px-3 py-2 font-mono text-[10px] text-muted">
          <div className="mb-1 text-[10px] uppercase tracking-wider">System</div>
          {systemEvents.slice().reverse().map((e, i) => (
            <div key={`${String(i)}-${e}`}>{e}</div>
          ))}
        </footer>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactElement }): ReactElement {
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card/40 p-3">
      <header className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {title}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function EmptyHint({ text }: { text: string }): ReactElement {
  return (
    <div className="rounded border border-dashed border-border px-4 py-8 text-center text-xs italic text-muted">
      {text}
    </div>
  );
}
