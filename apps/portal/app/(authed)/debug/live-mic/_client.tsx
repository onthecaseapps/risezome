'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AppStateProvider,
  CardActionsProvider,
  SynthesisActionsProvider,
  SynthesisStream,
  initialAppState,
  useAppDispatch,
  useAppState,
  type CardActions,
  type CardEvent as HudCardEvent,
  type SynthesisActions,
} from '@risezome/hud-ui';
import {
  TracePanel,
  indexTrace,
  type TraceEvent,
  type UtteranceTrace,
} from './_trace-panel';
import { OutputsPanel, type OutputCard, type OutputTab } from './_outputs-panel';
import { ColResizeHandle, useStoredColumnWidth } from './_resize';
import { deriveOutcome, type OutcomeType } from './_pipeline-model';
import { parseTranscriptFile, type ReplayUtterance } from './_replay-source';
import {
  computeSchedule,
  DEFAULT_CADENCE,
  type ReplayCadence,
  type ScheduledUtterance,
} from './_replay-driver';
import { formatReplaySummary, type ReplayUtteranceOutput } from './_replay-summary';

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
  /** Cosine distance when this was a vector candidate; undefined for an
   *  FTS-only hit (hybrid retrieval). */
  distance?: number;
  /** Fused RRF score (hybrid retrieval). */
  score?: number;
  /** Whether the chunk matched the lexical (full-text) query. */
  ftsMatched?: boolean;
  /** Matched chunk is the doc's generated summary (U6). */
  isSummary?: boolean;
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
  /** Validated ALSO: ranks; the reducer resolves them against the
   *  synthesis's sourceCardIds (same lookup citations use). */
  additionalSourceRanks?: number[];
  usage?: Record<string, unknown>;
}

interface RetrievalSkipEvent {
  type: 'retrieval-skip';
  reason: string;
  traceId?: string;
  detail?: string;
}

interface SkillResultItemPayload {
  title: string;
  url?: string;
  subtitle?: string;
}

interface SkillResultEvent {
  type: 'skillResult';
  traceId: string;
  utteranceId: string;
  skillName: string;
  args: Record<string, unknown>;
  kind: 'count' | 'list' | 'detail';
  summary: string;
  items: SkillResultItemPayload[];
}

interface MeetingSummaryPayload {
  summary: string;
  current_topic: string;
  open_questions: string[];
  key_terms: string[];
}

interface SummaryEvent {
  type: 'summary';
  summary: MeetingSummaryPayload;
  at: number;
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

interface SynthesisRetractEvent {
  type: 'synthesisRetract';
  synthesisId: string;
}

interface ReplayScopeEvent {
  type: 'replay-scope';
  scoped: boolean;
  meetingId: string | null;
}

type DebugEvent =
  | UtteranceEvent
  | CardEvent
  | SynthesisStartEvent
  | SynthesisDeltaEvent
  | SynthesisDoneEvent
  | SynthesisAbortedEvent
  | SynthesisRetractEvent
  | RetrievalSkipEvent
  | SkillResultEvent
  | SummaryEvent
  | TraceEvent
  | ReplayScopeEvent
  | OtherEvent;


interface SkillResultRecord {
  traceId: string;
  utteranceId: string;
  skillName: string;
  args: Record<string, unknown>;
  kind: 'count' | 'list' | 'detail';
  summary: string;
  items: SkillResultItemPayload[];
}

interface CardGroup {
  utteranceId: string;
  traceId: string;
  cards: CardEvent[];
}

export function LiveMicDebugClient(props: { wsUrl: string; orgId: string }): ReactElement {
  // Wrap in the same hud-ui providers the live meeting page uses, so the
  // synthesis renders with the real SynthesisStream — including click-to-
  // expand citations with quote highlighting. Pin/dismiss are no-ops here
  // (the debug session has no persistence).
  return (
    <AppStateProvider initial={{ ...initialAppState, meeting: 'live' }}>
      <CardActionsProvider actions={NOOP_CARD_ACTIONS}>
        <SynthesisActionsProvider actions={NOOP_SYNTHESIS_ACTIONS}>
          <DebugInner {...props} />
        </SynthesisActionsProvider>
      </CardActionsProvider>
    </AppStateProvider>
  );
}

function DebugInner({
  wsUrl,
  orgId,
}: {
  wsUrl: string;
  orgId: string;
}): ReactElement {
  const dispatch = useAppDispatch();
  const appState = useAppState();
  const synthesisCount = appState.syntheses.size;
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'errored'>(
    'idle',
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [utterances, setUtterances] = useState<UtteranceEvent[]>([]);
  const [cardGroups, setCardGroups] = useState<CardGroup[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResultRecord[]>([]);
  const [systemEvents, setSystemEvents] = useState<string[]>([]);
  const [currentSummary, setCurrentSummary] = useState<MeetingSummaryPayload | null>(null);
  const [summaryAt, setSummaryAt] = useState<number | null>(null);
  // U5: per-utterance stage-by-stage traces, indexed by utteranceId, plus the
  // currently-selected utterance whose trace the panel renders.
  const [tracesByUtterance, setTracesByUtterance] = useState<Map<string, UtteranceTrace>>(
    () => new Map(),
  );
  const [selectedUtteranceId, setSelectedUtteranceId] = useState<string | null>(null);
  // U5: the retrieval scope the sidecar resolved for the current replay session
  // (scoped to a meeting's source set, or whole-org / unscoped). Set on the
  // `replay-scope` WS event emitted on every replay-reset.
  const [replayScope, setReplayScope] = useState<{ scoped: boolean; meetingId: string | null } | null>(
    null,
  );
  const [outputTab, setOutputTab] = useState<OutputTab>('retrievals');
  const wsRef = useRef<WebSocket | null>(null);

  // U3 transcript replay: load a captured transcript + timings, replay through
  // the same WS at faithful (long-gap-capped) cadence. Refs hold the live timer
  // loop state so pause/resume/restart don't re-render every tick.
  const [replayUtterances, setReplayUtterances] = useState<ReplayUtterance[]>([]);
  const [replayMeetingId, setReplayMeetingId] = useState('');
  const [replayState, setReplayState] = useState<'idle' | 'playing' | 'paused' | 'done'>('idle');
  const [replaySent, setReplaySent] = useState(0);
  const [cadence, setCadence] = useState<ReplayCadence>(DEFAULT_CADENCE);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const replayTimersRef = useRef<number[]>([]);
  const replaySchedRef = useRef<ScheduledUtterance[]>([]);
  const replaySentRef = useRef(0);
  const replayElapsedRef = useRef(0);
  const replayStartWallRef = useRef(0);
  const summaryCopiedTimerRef = useRef<number | null>(null);
  // U4: the meeting id the loaded transcript came from (null for a file load),
  // sent on every `replay-reset` so the sidecar scopes retrieval to that meeting.
  const loadedMeetingIdRef = useRef<string | null>(null);

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
        // Keep the raw retrieval panel (debug-specific)…
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
        // …and feed the real HUD reducer so citation clicks can expand the
        // source card with its quote highlighted, exactly like the live page.
        dispatch({ type: 'card', card: toHudCard(c) });
        return;
      }
      case 'synthesisStart': {
        const s = evt as SynthesisStartEvent;
        // Stacks newest-first, matching the production live page.
        // `utteranceId` is debug-only.
        dispatch({
          type: 'synthesisStart',
          // Thread the (debug-only) utteranceId so the copy-summary can map the
          // answer text back to its utterance.
          start: {
            synthesisId: s.synthesisId,
            sourceCardIds: s.sourceCardIds,
            traceId: s.traceId,
            triggerUtteranceId: s.utteranceId,
          },
        });
        return;
      }
      case 'synthesisAborted': {
        const a = evt as SynthesisAbortedEvent;
        dispatch({
          type: 'synthesisRetracted',
          retracted: { synthesisId: a.synthesisId, reason: 'manual-dismiss' },
        });
        return;
      }
      case 'synthesisRetract': {
        // U3: a streamed answer that failed the grounding gate. Clear the
        // in-progress synthesis (grounded-or-nothing — nothing ungrounded
        // stands on the live page).
        const r = evt as SynthesisRetractEvent;
        dispatch({
          type: 'synthesisRetracted',
          retracted: { synthesisId: r.synthesisId, reason: 'source-retracted' },
        });
        return;
      }
      case 'synthesisDelta': {
        const d = evt as SynthesisDeltaEvent;
        dispatch({ type: 'synthesisDelta', delta: { synthesisId: d.synthesisId, delta: d.delta } });
        return;
      }
      case 'summary': {
        const s = evt as SummaryEvent;
        setCurrentSummary(s.summary);
        setSummaryAt(s.at);
        return;
      }
      case 'skillResult': {
        const s = evt as SkillResultEvent;
        setSkillResults((prev) =>
          [
            ...prev,
            {
              traceId: s.traceId,
              utteranceId: s.utteranceId,
              skillName: s.skillName,
              args: s.args,
              kind: s.kind,
              summary: s.summary,
              items: s.items,
            },
          ].slice(-10),
        );
        return;
      }
      case 'synthesisDone':
      case 'synthesisRefusal': {
        const d = evt as SynthesisDoneEvent;
        if (d.type === 'synthesisRefusal') {
          dispatch({
            type: 'synthesisError',
            error: { synthesisId: d.synthesisId, code: 'refused', message: d.accumulatedText },
          });
          return;
        }
        dispatch({
          type: 'synthesisDone',
          done: {
            synthesisId: d.synthesisId,
            stopReason: d.stopReason,
            citations: d.citations,
            ...(d.additionalSourceRanks !== undefined && d.additionalSourceRanks.length > 0
              ? { additionalSourceRanks: d.additionalSourceRanks }
              : {}),
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
            ttftMs: 0,
            latencyMs: 0,
          },
        });
        return;
      }
      case 'trace': {
        // U5: index the per-stage trace under its utteranceId (latest run wins).
        const t = evt as TraceEvent;
        setTracesByUtterance((prev) => indexTrace(prev, t));
        return;
      }
      case 'replay-scope': {
        // U5: the sidecar resolved the retrieval scope for this replay session
        // (emitted on every replay-reset). Surface it on the trace + summary.
        const s = evt as ReplayScopeEvent;
        setReplayScope({ scoped: s.scoped, meetingId: s.meetingId });
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
  }, [dispatch]);

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
      // A mid-replay disconnect must drain pending timers — otherwise they keep
      // firing into a dead socket and the UI stays stuck on "playing".
      for (const t of replayTimersRef.current) window.clearTimeout(t);
      replayTimersRef.current = [];
      setReplayState((s) => (s === 'playing' ? 'idle' : s));
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
      for (const t of replayTimersRef.current) window.clearTimeout(t);
      if (summaryCopiedTimerRef.current !== null) window.clearTimeout(summaryCopiedTimerRef.current);
    };
  }, []);

  // ── U3 replay control ──────────────────────────────────────────────────────
  const sendWs = useCallback((payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (ws === null || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const clearReplayTimers = useCallback(() => {
    for (const t of replayTimersRef.current) window.clearTimeout(t);
    replayTimersRef.current = [];
  }, []);

  // U4: a `replay-reset` carries the loaded transcript's meeting id (when it came
  // from a past meeting) so the sidecar scopes retrieval to that meeting; a file
  // load sends null → whole-org / unscoped.
  const sendReplayReset = useCallback((): void => {
    const meetingId = loadedMeetingIdRef.current;
    sendWs({ type: 'replay-reset', ...(meetingId !== null ? { meetingId } : {}) });
  }, [sendWs]);

  const onReplayLoaded = useCallback(
    (us: ReplayUtterance[], meetingId: string | null) => {
      // Loading a new source mid-playback must cancel the prior schedule (and
      // reset the sidecar) — otherwise its timers keep sending the old transcript.
      loadedMeetingIdRef.current = meetingId;
      clearReplayTimers();
      sendReplayReset();
      setReplayUtterances(us);
      setReplayState('idle');
      setReplaySent(0);
      replaySentRef.current = 0;
      replayElapsedRef.current = 0;
    },
    [clearReplayTimers, sendReplayReset],
  );

  const loadReplayFromMeeting = useCallback(async () => {
    const id = replayMeetingId.trim();
    if (id.length === 0) return;
    setReplayError(null);
    try {
      const res = await fetch(`/api/debug/replay-transcript?meetingId=${encodeURIComponent(id)}`);
      const json = (await res.json()) as { ok: boolean; utterances?: ReplayUtterance[]; error?: string };
      if (!res.ok || !json.ok || json.utterances === undefined) {
        setReplayError(json.error ?? `load failed (${String(res.status)})`);
        return;
      }
      onReplayLoaded(json.utterances, id); // scoped to this meeting (parity)
    } catch (e) {
      setReplayError(String(e));
    }
  }, [replayMeetingId, onReplayLoaded]);

  const loadReplayFromFile = useCallback(
    async (file: File) => {
      setReplayError(null);
      try {
        const parsed = parseTranscriptFile(await file.text());
        if (parsed.length === 0) {
          setReplayError('no utterances parsed from file');
          return;
        }
        onReplayLoaded(parsed, null); // file load — no meeting → whole-org / unscoped
      } catch (e) {
        setReplayError(String(e));
      }
    },
    [onReplayLoaded],
  );

  const playReplay = useCallback(() => {
    if (replayUtterances.length === 0) return;
    if (wsRef.current?.readyState !== 1) {
      setReplayError('Start the session first (the replay drives the live pipeline over the WS).');
      return;
    }
    setReplayError(null);
    // Fresh run from idle/done resets the sidecar + schedule; resume keeps elapsed.
    if (replayState !== 'paused') {
      sendReplayReset();
      replaySchedRef.current = computeSchedule(replayUtterances, cadence);
      replaySentRef.current = 0;
      replayElapsedRef.current = 0;
      setReplaySent(0);
    }
    const schedule = replaySchedRef.current;
    setReplayState('playing');
    replayStartWallRef.current = Date.now();
    clearReplayTimers();
    schedule.forEach((s, i) => {
      if (i < replaySentRef.current) return; // already sent (resume)
      const fireIn = Math.max(0, s.offsetMs - replayElapsedRef.current);
      const timer = window.setTimeout(() => {
        sendWs({
          type: 'replay-utterance',
          utteranceId: s.utterance.utteranceId,
          text: s.utterance.text,
          speaker: s.utterance.speaker,
          startMs: s.utterance.startMs,
        });
        replaySentRef.current = i + 1;
        setReplaySent(i + 1);
        if (i + 1 >= schedule.length) setReplayState('done');
      }, fireIn);
      replayTimersRef.current.push(timer);
    });
  }, [replayUtterances, cadence, replayState, sendWs, sendReplayReset, clearReplayTimers]);

  const pauseReplay = useCallback(() => {
    clearReplayTimers();
    replayElapsedRef.current += Date.now() - replayStartWallRef.current;
    setReplayState('paused');
  }, [clearReplayTimers]);

  const restartReplay = useCallback(() => {
    clearReplayTimers();
    sendReplayReset();
    replaySentRef.current = 0;
    replayElapsedRef.current = 0;
    setReplaySent(0);
    setReplayState('idle');
  }, [clearReplayTimers, sendReplayReset]);

  // U5: copy a structured, LLM-pasteable dump of the whole replay (every
  // utterance's outcome, skill-vs-RAG route + reason, gates, prior context).
  const copyReplaySummary = useCallback(() => {
    // Per-utterance I/O the trace doesn't carry: retrieved cards (from the card
    // stream) and the synthesized answer (from the reducer), keyed by utteranceId.
    const outputsById = new Map<string, ReplayUtteranceOutput>();
    for (const g of cardGroups) {
      outputsById.set(g.utteranceId, {
        cards: g.cards.map((c) => ({
          rank: c.rank,
          source: c.source,
          title: c.title,
          ...(c.score !== undefined ? { score: c.score } : {}),
          ...(c.distance !== undefined ? { distance: c.distance } : {}),
        })),
      });
    }
    for (const syn of appState.syntheses.values()) {
      const uid = syn.triggerUtteranceId;
      if (uid == null || syn.accumulatedText.length === 0) continue;
      outputsById.set(uid, { ...outputsById.get(uid), answer: syn.accumulatedText });
    }
    const text = formatReplaySummary(replayUtterances, tracesByUtterance, replayScope, outputsById);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setSummaryCopied(true);
        if (summaryCopiedTimerRef.current !== null) window.clearTimeout(summaryCopiedTimerRef.current);
        summaryCopiedTimerRef.current = window.setTimeout(() => setSummaryCopied(false), 1500);
      })
      .catch(() => setReplayError('clipboard write failed'));
  }, [replayUtterances, tracesByUtterance, replayScope, cardGroups, appState.syntheses]);

  const reset = useCallback(() => {
    // Clears the debug-specific panels AND the HUD reducer (synthesis cards +
    // retrieval cards + transcript live in the reducer, not local component
    // state) via the `reset` action, so Clear fully wipes the screen.
    // Cancel any in-flight replay too, so Clear during playback doesn't leave
    // timers firing into the cleared panels.
    clearReplayTimers();
    replaySentRef.current = 0;
    replayElapsedRef.current = 0;
    setReplaySent(0);
    setReplayState('idle');
    setUtterances([]);
    setCardGroups([]);
    setSkillResults([]);
    setSystemEvents([]);
    setCurrentSummary(null);
    setSummaryAt(null);
    setTracesByUtterance(new Map());
    setSelectedUtteranceId(null);
    setReplayScope(null);
    dispatch({ type: 'reset' });
  }, [clearReplayTimers, dispatch]);

  // U5: the selected utterance's trace + text + retrieved cards. The cards
  // arrive via `card` events (the trace's hybrid-search stage carries only a
  // count), so we resolve them from `cardGroups` by utteranceId here.
  const selectedTrace: UtteranceTrace | null =
    selectedUtteranceId !== null ? (tracesByUtterance.get(selectedUtteranceId) ?? null) : null;
  const selectedUtteranceText: string | null = useMemo(() => {
    if (selectedUtteranceId === null) return null;
    return utterances.find((u) => u.utteranceId === selectedUtteranceId)?.text ?? null;
  }, [selectedUtteranceId, utterances]);
  const selectedCards: OutputCard[] = useMemo(() => {
    if (selectedUtteranceId === null) return [];
    return cardGroups
      .filter((g) => g.utteranceId === selectedUtteranceId)
      .flatMap((g) => g.cards)
      .map((c) => ({
        cardId: c.cardId,
        rank: c.rank,
        title: c.title,
        source: c.source,
        docType: c.docType,
        url: c.url,
        snippet: c.snippet,
        body: c.body,
        ...(c.distance !== undefined ? { distance: c.distance } : {}),
        ...(c.score !== undefined ? { score: c.score } : {}),
        ...(c.ftsMatched !== undefined ? { ftsMatched: c.ftsMatched } : {}),
        ...(c.isSummary !== undefined ? { isSummary: c.isSummary } : {}),
      }));
  }, [selectedUtteranceId, cardGroups]);

  // U5: the selected utterance's terminal outcome (drives the Retrievals
  // empty-state tone + the rail chip mapping) and the stage→Outputs deep-link.
  const selectedOutcome: OutcomeType = useMemo(
    () => deriveOutcome(selectedTrace).type,
    [selectedTrace],
  );
  const onOpenOutput = useCallback((tab: 'retrievals' | 'synthesis') => {
    setOutputTab(tab);
  }, []);

  // Resizable columns: utterances (left) and outputs (right) are draggable via
  // handles; the trace column takes the remainder. Widths persist locally.
  const leftCol = useStoredColumnWidth('live-mic.col.utterances', 260, 180, 560, 1);
  const rightCol = useStoredColumnWidth('live-mic.col.outputs', 420, 280, 760, -1);
  const colsDragging = leftCol.dragging || rightCol.dragging;

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

      <SummaryStrip summary={currentSummary} summaryAt={summaryAt} />

      <div className="mb-4 rounded-lg border border-border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Replay</span>
          <input
            value={replayMeetingId}
            onChange={(e) => setReplayMeetingId(e.target.value)}
            placeholder="meeting ID"
            className="w-72 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => void loadReplayFromMeeting()}
            className="rounded-md border border-border bg-card px-2 py-1 font-medium hover:bg-accent-soft"
          >
            Load meeting
          </button>
          <label className="cursor-pointer rounded-md border border-border bg-card px-2 py-1 font-medium hover:bg-accent-soft">
            Load file
            <input
              type="file"
              accept=".txt,.json,.jsonl,.md"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f !== undefined) void loadReplayFromFile(f);
              }}
            />
          </label>
          <span className="text-muted">{replayUtterances.length} utterances</span>

          <span className="mx-1 h-4 w-px bg-border" />

          {replayState === 'playing' ? (
            <button
              type="button"
              onClick={pauseReplay}
              className="rounded-md border border-border bg-card px-2 py-1 font-medium hover:bg-accent-soft"
            >
              Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={playReplay}
              disabled={replayUtterances.length === 0}
              className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent-press disabled:opacity-40"
            >
              {replayState === 'paused' ? 'Resume' : 'Play'}
            </button>
          )}
          <button
            type="button"
            onClick={restartReplay}
            disabled={replayUtterances.length === 0}
            className="rounded-md border border-border bg-card px-2 py-1 font-medium text-muted hover:text-fg disabled:opacity-40"
          >
            Restart
          </button>
          <span className="tabular-nums text-muted">
            {replaySent}/{replayUtterances.length}
          </span>
          <button
            type="button"
            onClick={copyReplaySummary}
            disabled={replayUtterances.length === 0}
            title="Copy a structured summary of every utterance's route, gates, and prior context for LLM analysis"
            className="rounded-md border border-border bg-card px-2 py-1 font-medium text-muted hover:text-fg disabled:opacity-40"
          >
            {summaryCopied ? 'Copied ✓' : 'Copy summary'}
          </button>

          <span className="mx-1 h-4 w-px bg-border" />

          <label className="flex items-center gap-1 text-muted">
            speed×
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={cadence.speed}
              onChange={(e) =>
                setCadence((c) => ({ ...c, speed: Number(e.target.value) > 0 ? Number(e.target.value) : c.speed }))
              }
              className="w-14 rounded-md border border-border bg-bg px-1 py-0.5 tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1 text-muted">
            max gap ms
            <input
              type="number"
              min={0}
              step={500}
              value={cadence.maxGapMs}
              onChange={(e) =>
                setCadence((c) => ({ ...c, maxGapMs: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : c.maxGapMs }))
              }
              className="w-20 rounded-md border border-border bg-bg px-1 py-0.5 tabular-nums"
            />
          </label>
          {replayError !== null ? <span className="text-rose-400">{replayError}</span> : null}
        </div>
      </div>

      <div
        className={`grid min-h-0 flex-1 gap-1 ${colsDragging ? 'select-none' : ''}`}
        style={{ gridTemplateColumns: `${String(leftCol.width)}px auto 1fr auto ${String(rightCol.width)}px` }}
      >
        <Panel title={`Utterances (${utterances.length})`}>
          {utterances.length === 0 ? (
            <EmptyHint text="Start a session and start speaking. Partials appear as they stream; finals trigger retrieval." />
          ) : (
            <ul className="space-y-2 text-sm">
              {utterances.slice().reverse().map((u) => {
                // U5: final utterances are clickable → select to open the trace
                // panel. A dot marks utterances that already have a trace.
                const selected = u.utteranceId === selectedUtteranceId;
                const uTrace = tracesByUtterance.get(u.utteranceId);
                if (!u.isFinal) {
                  return (
                    <li
                      key={`${u.utteranceId}-${String(u.revision)}`}
                      className="rounded border border-dashed border-border px-3 py-2 italic text-muted"
                    >
                      <div className="text-[10px] uppercase tracking-wider text-muted">
                        partial · rev {String(u.revision)} · {u.utteranceId.slice(-6)}
                      </div>
                      <div className="mt-0.5">{u.text}</div>
                    </li>
                  );
                }
                return (
                  <li key={`${u.utteranceId}-${String(u.revision)}`}>
                    <button
                      type="button"
                      onClick={() => setSelectedUtteranceId(u.utteranceId)}
                      aria-pressed={selected}
                      className={
                        'block w-full rounded border px-3 py-2 text-left transition-colors ' +
                        (selected
                          ? 'border-accent bg-accent-soft/40'
                          : 'border-border bg-card hover:bg-accent-soft/20')
                      }
                    >
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted">
                        <span>final · rev {String(u.revision)} · {u.utteranceId.slice(-6)}</span>
                      </div>
                      <div className="mt-0.5 text-fg">{u.text}</div>
                      <RailOutcomeChip trace={uTrace} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <ColResizeHandle
          onPointerDown={leftCol.onPointerDown}
          dragging={leftCol.dragging}
          label="Resize utterances column"
        />

        <Panel
          title={
            selectedUtteranceId !== null
              ? `Trace · ${selectedUtteranceId.slice(-6)}`
              : 'Trace'
          }
        >
          <>
            {replayScope !== null ? (
              <div className="mb-2 text-[10px] uppercase tracking-wider text-muted">
                Retrieval scope:{' '}
                <span className="normal-case text-fg">
                  {replayScope.scoped && replayScope.meetingId !== null
                    ? `scoped to meeting ${replayScope.meetingId}`
                    : 'unscoped (no meeting)'}
                </span>
              </div>
            ) : null}
            <TracePanel
              trace={selectedTrace}
              utteranceText={selectedUtteranceText}
              onOpenOutput={onOpenOutput}
            />
          </>
        </Panel>

        <ColResizeHandle
          onPointerDown={rightCol.onPointerDown}
          dragging={rightCol.dragging}
          label="Resize outputs column"
        />

        <section className="flex min-h-0 flex-col rounded-xl border border-border bg-card/40 p-3">
          <OutputsPanel
            tab={outputTab}
            onTab={setOutputTab}
            cards={selectedCards}
            synthesisCount={synthesisCount}
            trace={selectedTrace}
            outcomeType={selectedOutcome}
            synthesis={
              <>
                {/* Skill answers: structured tool results (github_count etc.)
                    shown directly, independent of synthesis. The synthesizer
                    can refuse; the raw skill answer never hides. */}
                {skillResults.length > 0 && (
                  <ul className="mb-3 space-y-2 text-sm">
                    {skillResults.slice().reverse().map((sr) => (
                      <li
                        key={`${sr.traceId}-${sr.skillName}`}
                        className="rounded border border-accent/50 bg-accent-soft/40 p-3"
                      >
                        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-accent">
                          <span className="rounded bg-accent/20 px-1.5 py-0.5 font-semibold">Skill</span>
                          <span className="font-mono normal-case text-muted">
                            {sr.skillName}({JSON.stringify(sr.args)})
                          </span>
                        </div>
                        <div className="mt-1 font-medium">{sr.summary}</div>
                        {sr.items.length > 0 && (
                          <ol className="mt-1.5 space-y-1 text-xs">
                            {sr.items.map((item, i) => (
                              <li key={`${sr.traceId}-item-${String(i)}`} className="border-l-2 border-accent/40 pl-2">
                                {item.url !== undefined ? (
                                  <a href={item.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                                    {item.title}
                                  </a>
                                ) : (
                                  <span>{item.title}</span>
                                )}
                                {item.subtitle !== undefined && (
                                  <span className="text-muted"> — {item.subtitle}</span>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {synthesisCount === 0 && skillResults.length === 0 ? (
                  <EmptyHint text='Synthesis streams here exactly as on the live meeting page — click a [N] citation to expand the source card with its quote highlighted.' />
                ) : (
                  <SynthesisStream />
                )}
              </>
            }
          />
        </section>
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

/** Terminal-outcome chip on a final-utterance rail row (U5). Renders only once
 *  the utterance has a trace; before that the row is just the transcript line. */
const RAIL_OUTCOME: Record<OutcomeType, { label: string; color: string } | null> = {
  grounded: { label: 'GROUNDED', color: '#46c08a' },
  miss: { label: 'MISS · GAP', color: '#f0616d' },
  skip: { label: 'SKIPPED', color: '#e6a23c' },
  ungrounded: { label: 'UNGROUNDED', color: '#f0616d' },
  refusal: { label: 'REFUSED', color: '#f0616d' },
  pending: null,
};

function RailOutcomeChip({ trace }: { trace: UtteranceTrace | undefined }): ReactElement | null {
  if (!trace) return null;
  const meta = RAIL_OUTCOME[deriveOutcome(trace).type];
  if (!meta) return null;
  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tracking-wide"
      style={{ background: `${meta.color}26`, color: meta.color }}
    >
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
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

/**
 * DEBUG-ONLY summary panel. DO NOT promote this panel to the live page
 * without revisiting the identity-drift Risks-table decision in
 * docs/plans/2026-05-31-002-feat-rolling-meeting-summary-plan.md —
 * surfacing the rolling summary as a user-facing artifact moves the
 * product toward "AI meeting assistant" territory, which is a
 * deliberate non-goal of V1.
 *
 * Styled monospace + dense + no chrome so the visual language reads as
 * "diagnostic tool", not "feature".
 */
function SummaryStrip({
  summary,
  summaryAt,
}: {
  summary: MeetingSummaryPayload | null;
  summaryAt: number | null;
}): ReactElement {
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (summary === null || summaryAt === null) {
    return (
      <section className="mb-3 rounded border border-dashed border-border bg-card/30 px-3 py-2 font-mono text-[11px] text-muted">
        <span className="uppercase tracking-wider">Rolling summary</span>{' '}
        <span className="italic">
          No summary yet — first refresh after 30 seconds or 5 utterances.
        </span>
      </section>
    );
  }

  const ageMs = now - summaryAt;
  const ageSec = Math.max(0, Math.floor(ageMs / 1000));
  const isStale = ageMs > 5 * 60_000;

  return (
    <section
      className={
        'mb-3 rounded border border-border bg-card/40 px-3 py-2 font-mono text-[11px]' +
        (isStale ? ' opacity-60' : '')
      }
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="uppercase tracking-wider text-muted">Topic</span>
          <span className="text-sm font-semibold text-fg">
            {summary.current_topic.length > 0 ? summary.current_topic : '(none)'}
          </span>
        </div>
        <span className={isStale ? 'text-rose-400' : 'text-muted'}>
          Updated {String(ageSec)}s ago
        </span>
      </div>
      {summary.summary.length > 0 && (
        <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-fg/90">
          {summary.summary}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-start gap-x-4 gap-y-1">
        {summary.open_questions.length > 0 && (
          <div className="flex-1 min-w-[200px]">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Open questions
            </div>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px] text-fg/90">
              {summary.open_questions.map((q, i) => (
                <li key={`oq-${String(i)}`}>{q}</li>
              ))}
            </ul>
          </div>
        )}
        {summary.key_terms.length > 0 && (
          <div className="flex-1 min-w-[200px]">
            <div className="text-[10px] uppercase tracking-wider text-muted">
              Key terms
            </div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {summary.key_terms.map((t, i) => (
                <span
                  key={`kt-${String(i)}`}
                  className="rounded border border-border bg-code-bg px-1.5 py-0.5 text-[10px]"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const NOOP_CARD_ACTIONS: CardActions = {
  pin: async () => undefined,
  unpin: async () => undefined,
  dismiss: async () => undefined,
};

const NOOP_SYNTHESIS_ACTIONS: SynthesisActions = {
  pin: async () => undefined,
  unpin: async () => undefined,
};

/** Map a debug-WS card payload to the hud-ui CardEvent the reducer expects. */
function toHudCard(c: CardEvent): HudCardEvent {
  return {
    cardId: c.cardId,
    docId: c.docId,
    source: c.source,
    type: c.docType,
    title: c.title,
    snippet: c.snippet,
    body: c.body,
    score: c.distance !== undefined ? 1 - c.distance : (c.score ?? 0.5),
    rank: c.rank,
    ...(c.isSummary === true ? { isSummary: true } : {}),
    metadata: {},
    surfacedAt: Date.now(),
    triggeredBy: 'window',
    traceId: c.traceId,
    utteranceId: c.utteranceId,
    ...(c.url !== null ? { url: c.url } : {}),
  };
}
