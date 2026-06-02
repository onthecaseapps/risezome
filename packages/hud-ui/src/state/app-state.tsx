'use client';

import {
  createContext,
  useContext,
  useReducer,
  type Dispatch,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  CardEvent,
  CardRetracted,
  CardUpdated,
  GapEvent,
  SynthesisCitation,
  SynthesisDeltaEvent,
  SynthesisDoneEvent,
  SynthesisErrorEvent,
  SynthesisRetractedEvent,
  SynthesisStartEvent,
  TranscriptUtterance,
} from '../types';
/**
 * Connection status reported by the transport layer (daemon WS in
 * hud-next, Supabase Realtime in the portal). The reducer doesn't
 * care which transport — only the lifecycle stages it can be in.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'disconnected';

// Backwards-compatible alias for hud-next's existing call sites that
// imported WsStatus from the lifted module.
export type WsStatus = ConnectionStatus;

export interface CardRecord {
  readonly card: CardEvent;
  readonly pinned: boolean;
}

export interface SynthesisRecord {
  readonly synthesisId: string;
  readonly sourceCardIds: readonly string[];
  readonly traceId: string;
  readonly accumulatedText: string;
  readonly streaming: boolean;
  readonly citations: readonly SynthesisCitation[];
  readonly stopReason?: string;
  readonly ttftMs?: number;
  readonly latencyMs?: number;
  /** Whether the user has pinned this synthesis to the top of the
   *  page (plan U5). False by default; flips via the
   *  `synthesisPinned` reducer action which the pin server action
   *  drives. */
  readonly pinned: boolean;
  /** ISO timestamp of the most recent pin action. Null when unpinned.
   *  Used by PinnedSynthesesSection for pin-time DESC ordering. */
  readonly pinnedAt: string | null;
}

export type MeetingMode = 'idle' | 'live';

export interface AppState {
  readonly status: WsStatus;
  readonly meeting: MeetingMode;
  /** Insertion-ordered map keyed by cardId. */
  readonly cards: ReadonlyMap<string, CardRecord>;
  /** Insertion-ordered map keyed by gapId. */
  readonly gaps: ReadonlyMap<string, GapEvent>;
  /** Insertion-ordered map keyed by synthesisId. */
  readonly syntheses: ReadonlyMap<string, SynthesisRecord>;
  /** Live transcript, keyed by utteranceId (a partial and its final share an
   *  id). Insertion-ordered; render-time sort by startMs handles the rare
   *  out-of-order arrival. */
  readonly transcript: ReadonlyMap<string, TranscriptUtterance>;
  /** Updated only on synthesisDone — feeds the sr-only aria-live announce region. */
  readonly lastSynthesisAnnounce: string | null;
  /** Count of consecutive synthesis errors / refusals since the last
   *  successful synthesisDone. Drives the "AI summaries paused" header
   *  pill on the live page (plan U8 / S3). Incremented on
   *  synthesisError + synthesisRetracted; reset to 0 on synthesisDone. */
  readonly synthesisFailureStreak: number;
}

/**
 * Threshold at which the "AI summaries paused" UI surfaces. Three
 * consecutive failures distinguishes a one-off glitch (we can stay
 * quiet) from a sustained problem (the user should know). Exported so
 * both the reducer test and the header pill consume the same constant.
 */
export const SYNTHESIS_PAUSED_THRESHOLD = 3;

export const initialAppState: AppState = {
  status: 'disconnected',
  meeting: 'idle',
  cards: new Map(),
  gaps: new Map(),
  syntheses: new Map(),
  transcript: new Map(),
  lastSynthesisAnnounce: null,
  synthesisFailureStreak: 0,
};

export type AppAction =
  | { type: 'wsStatus'; status: WsStatus }
  | { type: 'card'; card: CardEvent }
  | { type: 'cardUpdated'; update: CardUpdated }
  | { type: 'cardRetracted'; retracted: CardRetracted }
  | { type: 'cardPinned'; cardId: string; pinned: boolean }
  | { type: 'gap'; gap: GapEvent }
  | { type: 'meetingStarted' }
  | { type: 'meetingEnded' }
  | { type: 'meetingStatus'; mode: MeetingMode }
  | { type: 'synthesisStart'; start: SynthesisStartEvent }
  | { type: 'synthesisDelta'; delta: SynthesisDeltaEvent }
  | { type: 'synthesisDone'; done: SynthesisDoneEvent }
  | { type: 'synthesisError'; error: SynthesisErrorEvent }
  | { type: 'synthesisRetracted'; retracted: SynthesisRetractedEvent }
  | { type: 'synthesisPinned'; synthesisId: string; pinned: boolean; pinnedAt: string | null }
  | { type: 'transcriptUtterance'; utterance: TranscriptUtterance };

function cloneMap<K, V>(m: ReadonlyMap<K, V>): Map<K, V> {
  return new Map(m);
}

export function appStateReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'wsStatus':
      if (state.status === action.status) return state;
      return { ...state, status: action.status };

    case 'card': {
      const cards = cloneMap(state.cards);
      const existing = cards.get(action.card.cardId);
      cards.set(action.card.cardId, { card: action.card, pinned: existing?.pinned ?? false });
      return { ...state, cards };
    }

    case 'cardUpdated': {
      const existing = state.cards.get(action.update.cardId);
      if (existing === undefined) return state;
      const cards = cloneMap(state.cards);
      const merged: CardEvent = {
        ...existing.card,
        score: action.update.score ?? existing.card.score,
        triggeredBy: action.update.triggeredBy ?? existing.card.triggeredBy,
        metadata: action.update.metadata ?? existing.card.metadata,
      };
      cards.set(action.update.cardId, { ...existing, card: merged });
      return { ...state, cards };
    }

    case 'cardPinned': {
      const existing = state.cards.get(action.cardId);
      if (existing === undefined) return state;
      if (existing.pinned === action.pinned) return state;
      const cards = cloneMap(state.cards);
      cards.set(action.cardId, { ...existing, pinned: action.pinned });
      return { ...state, cards };
    }

    case 'cardRetracted': {
      if (!state.cards.has(action.retracted.cardId)) return state;
      // Cascade: drop only STILL-STREAMING, unpinned syntheses citing the
      // retracted card. A streaming answer that loses a source mid-generation
      // is stale and should go; a COMPLETED answer must survive — it was
      // already rendered, and source cards routinely rotate out of the live
      // window. Without the `streaming` guard, the Realtime reconnect-replay
      // fast-forwards every historical window-eviction cardRetracted in one
      // pass and cascades away all but the newest summary (the seeded feed
      // "flashes then collapses to one"). Pinned syntheses already survive
      // (explicit keep-on-screen intent); this gives done syntheses the same
      // protection.
      const syntheses = cloneMap(state.syntheses);
      let cascaded = false;
      for (const [id, syn] of syntheses) {
        if (syn.streaming && !syn.pinned && syn.sourceCardIds.includes(action.retracted.cardId)) {
          syntheses.delete(id);
          cascaded = true;
        }
      }
      const survivingSyntheses = cascaded ? syntheses : state.syntheses;
      // Keep a retracted card in state while a SURVIVING synthesis still cites
      // it, so that answer keeps rendering its SOURCES list + "grounded in N"
      // count. On the live page cards appear ONLY as a synthesis's sources (no
      // standalone card stream), and prod retracts a prior card whenever dedup
      // churn re-issues the same doc under a new cardId — without this, every
      // completed answer whose source got re-surfaced drops to "grounded in 0
      // sources" with dead inline chips. Drop the card only once nothing cites
      // it. (The debug page never emits cardRetracted, so its apply-once stream
      // is unaffected — this just brings prod to the same durable behaviour.)
      let stillCited = false;
      for (const syn of survivingSyntheses.values()) {
        if (syn.sourceCardIds.includes(action.retracted.cardId)) {
          stillCited = true;
          break;
        }
      }
      let cards: typeof state.cards = state.cards;
      if (!stillCited) {
        const next = cloneMap(state.cards);
        next.delete(action.retracted.cardId);
        cards = next;
      }
      return { ...state, cards, syntheses: cascaded ? syntheses : state.syntheses };
    }

    case 'gap': {
      const gaps = cloneMap(state.gaps);
      gaps.set(action.gap.gapId, action.gap);
      return { ...state, gaps };
    }

    case 'meetingStarted':
      if (state.meeting === 'live') return state;
      return { ...state, meeting: 'live' };

    case 'meetingEnded':
      if (state.meeting === 'idle') return state;
      return { ...state, meeting: 'idle' };

    case 'meetingStatus':
      if (state.meeting === action.mode) return state;
      return { ...state, meeting: action.mode };

    case 'synthesisStart': {
      // S6 (replay-on-reconnect): if a record for this synthesisId is
      // already in state (hydrated from initial DB fetch, or kept from
      // a prior session), treat the replayed synthesisStart as a no-op
      // rather than resetting accumulatedText to '' and streaming to
      // true. Without this guard, the channel's reconnect-replay would
      // wipe in-flight or completed synthesis text every time the
      // socket flapped.
      if (state.syntheses.has(action.start.synthesisId)) return state;
      const syntheses = cloneMap(state.syntheses);
      const rec: SynthesisRecord = {
        synthesisId: action.start.synthesisId,
        sourceCardIds: action.start.sourceCardIds,
        traceId: action.start.traceId,
        accumulatedText: '',
        streaming: true,
        citations: [],
        pinned: false,
        pinnedAt: null,
      };
      syntheses.set(action.start.synthesisId, rec);
      return { ...state, syntheses };
    }

    case 'synthesisDelta': {
      const existing = state.syntheses.get(action.delta.synthesisId);
      if (existing === undefined) return state;
      // S6 (replay-on-reconnect) idempotency, mirroring the synthesisStart
      // guard above: a synthesis that has already completed (streaming=false
      // — hydrated from the initial DB seed, or finalized live) must NOT
      // accept further deltas. Without this, the Realtime channel's
      // reconnect-replay re-appends the full answer on top of the seeded
      // text and the card renders doubled. Deltas only ever apply while a
      // synthesis is actively streaming — the same apply-once behaviour the
      // direct-WS debug page gets for free.
      if (!existing.streaming) return state;
      const syntheses = cloneMap(state.syntheses);
      syntheses.set(action.delta.synthesisId, {
        ...existing,
        accumulatedText: existing.accumulatedText + action.delta.delta,
      });
      return { ...state, syntheses };
    }

    case 'synthesisDone': {
      const existing = state.syntheses.get(action.done.synthesisId);
      if (existing === undefined) return state;
      const syntheses = cloneMap(state.syntheses);
      const updated: SynthesisRecord = {
        ...existing,
        streaming: false,
        citations: action.done.citations,
        stopReason: action.done.stopReason,
        ttftMs: action.done.ttftMs,
        latencyMs: action.done.latencyMs,
      };
      syntheses.set(action.done.synthesisId, updated);
      // U8: a successful done resets the paused-pill streak.
      return {
        ...state,
        syntheses,
        lastSynthesisAnnounce: updated.accumulatedText,
        synthesisFailureStreak: 0,
      };
    }

    case 'synthesisError': {
      if (!state.syntheses.has(action.error.synthesisId)) return state;
      const syntheses = cloneMap(state.syntheses);
      syntheses.delete(action.error.synthesisId);
      // U8: count toward the paused-pill threshold.
      return {
        ...state,
        syntheses,
        synthesisFailureStreak: state.synthesisFailureStreak + 1,
      };
    }

    case 'synthesisRetracted': {
      if (!state.syntheses.has(action.retracted.synthesisId)) return state;
      const syntheses = cloneMap(state.syntheses);
      syntheses.delete(action.retracted.synthesisId);
      // U8: refusals also count toward the paused-pill threshold.
      return {
        ...state,
        syntheses,
        synthesisFailureStreak: state.synthesisFailureStreak + 1,
      };
    }

    case 'synthesisPinned': {
      const existing = state.syntheses.get(action.synthesisId);
      if (existing === undefined) return state;
      if (existing.pinned === action.pinned && existing.pinnedAt === action.pinnedAt) {
        return state;
      }
      const syntheses = cloneMap(state.syntheses);
      syntheses.set(action.synthesisId, {
        ...existing,
        pinned: action.pinned,
        pinnedAt: action.pinnedAt,
      });
      return { ...state, syntheses };
    }

    case 'transcriptUtterance': {
      const incoming = action.utterance;
      const existing = state.transcript.get(incoming.utteranceId);
      if (existing !== undefined) {
        // A final is authoritative — never let a (replayed) partial overwrite
        // it. Replay-idempotency is the same invariant the synthesis guards on
        // this surface uphold: the Realtime reconnect re-delivers utterances.
        if (existing.isFinal && !incoming.isFinal) return state;
        // Same finality: last-revision-wins; a stale or duplicate replay
        // (revision <=) is dropped, keeping reconnect idempotent.
        if (existing.isFinal === incoming.isFinal && incoming.revision <= existing.revision) {
          return state;
        }
      }
      // Map.set preserves insertion order on update, so a final replaces its
      // partial in place; the panel sorts by startMs for display.
      const transcript = cloneMap(state.transcript);
      transcript.set(incoming.utteranceId, incoming);
      return { ...state, transcript };
    }

    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

const AppStateContext = createContext<AppState | null>(null);
const AppDispatchContext = createContext<Dispatch<AppAction> | null>(null);

export function AppStateProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: AppState;
}): ReactElement {
  const [state, dispatch] = useReducer(appStateReducer, initial ?? initialAppState);
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>{children}</AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (ctx === null) throw new Error('useAppState must be used inside AppStateProvider');
  return ctx;
}

export function useAppDispatch(): Dispatch<AppAction> {
  const ctx = useContext(AppDispatchContext);
  if (ctx === null) throw new Error('useAppDispatch must be used inside AppStateProvider');
  return ctx;
}
