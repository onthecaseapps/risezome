'use client';

import { useEffect, useRef, useState } from 'react';
import { getBrowserClient } from './supabase-browser';
import type { AppAction, TranscriptUtterance } from '@risezome/hud-ui';

/**
 * Subscribe to a meeting's Realtime channel + dispatch broadcast
 * events through the AppState reducer.
 *
 * Channel name: `meeting:<orgId>:<meetingId>` — matches the bot-worker's
 * channelName() helper in apps/bot-worker/src/db.ts. The realtime.messages
 * RLS policy (20260602100000_realtime_meeting_rls.sql) lets org members
 * SELECT broadcasts on that topic.
 *
 * Currently handled broadcast event types:
 *   meetingStatus → dispatch reducer's meetingStatus action AND surface
 *                   the new status to the caller so it can swap shells
 *   transcript.*  → no-op for now (no reducer action; future units may
 *                   add a transcript ticker)
 *   card / cardUpdated / cardRetracted              → dispatch
 *   synthesis*                                      → dispatch
 *
 * Reconnect-fetch: when the subscription transitions to SUBSCRIBED
 * (either initial connect or reconnect after drop), fetch all
 * meeting_events with event_id > lastSeen and replay through dispatch
 * so missed broadcasts are recovered. The reducer is idempotent for
 * any event we re-deliver (cards keyed by cardId, syntheses by
 * synthesisId).
 */

export type BroadcastedStatus =
  | 'launching'
  | 'awaiting_recall'
  | 'joining'
  | 'waiting_room'
  | 'recording'
  | 'completed'
  | 'failed';

export interface UseRealtimeMeetingChannelOpts {
  meetingId: string;
  orgId: string;
  /** AppStateProvider's useAppDispatch return value. */
  dispatch: (action: AppAction) => void;
  /** Last event_id processed during initial DB fetch on the server. */
  initialLastEventId?: number;
}

export interface ChannelState {
  status: 'idle' | 'connecting' | 'subscribed' | 'errored';
  liveMeetingStatus: BroadcastedStatus | null;
}

/** How often the live page polls meeting_events for new content (ms). */
const CONTENT_POLL_MS = 2500;

export function useRealtimeMeetingChannel(opts: UseRealtimeMeetingChannelOpts): ChannelState {
  const { meetingId, orgId, dispatch } = opts;
  const lastSeenRef = useRef<number>(opts.initialLastEventId ?? 0);
  const [state, setState] = useState<ChannelState>({
    status: 'idle',
    liveMeetingStatus: null,
  });

  useEffect(() => {
    const supabase = getBrowserClient();
    const topic = `meeting:${orgId}:${meetingId}`;

    setState((s) => ({ ...s, status: 'connecting' }));

    // The channel is created + subscribed AFTER the realtime socket has the
    // user's JWT (see below), so hold a ref for the cleanup closure.
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    void (async () => {
      // Private channels authorize against the realtime.messages RLS policy
      // using the caller's JWT. createBrowserClient (@supabase/ssr) hydrates
      // the session from cookies ASYNCHRONOUSLY, so subscribing immediately
      // races: the socket can authorize the private topic before the JWT is
      // attached → auth.uid() is null → RLS rejects → CHANNEL_ERROR. That
      // failure killed BOTH live deltas and the reconnect-fetch recovery, so
      // the live HUD stayed empty even though cards/syntheses were durable in
      // meeting_events (the status-poll fallback below masked it by flipping
      // the shell to recording). Load the session and set the realtime auth
      // token explicitly BEFORE subscribing so authorization is deterministic.
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token !== undefined) {
        await supabase.realtime.setAuth(token);
      }
      if (cancelled) return;

      channel = supabase.channel(topic, { config: { private: true } });

      channel.on('broadcast', { event: '*' }, (event) => {
        const eventType = event.event;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const eventId = typeof payload['eventId'] === 'number' ? (payload['eventId'] as number) : null;
        if (eventId !== null && eventId > lastSeenRef.current) {
          lastSeenRef.current = eventId;
        }
        // LIVE broadcast path — interim (partial) utterances are dispatched
        // here so the live line can morph word-by-word. Interims carry no
        // persisted eventId, so lastSeenRef is never advanced by them above.
        dispatchBroadcast(eventType, payload, dispatch, setState, true);
      });

      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          setState((s) => ({ ...s, status: 'subscribed' }));
          await reconnectFetch({
            orgId,
            meetingId,
            afterEventId: lastSeenRef.current,
            dispatch,
            onMaxEventId: (id) => {
              if (id > lastSeenRef.current) lastSeenRef.current = id;
            },
            onMeetingStatus: (live) => {
              setState((s) => (s.liveMeetingStatus === live ? s : { ...s, liveMeetingStatus: live }));
            },
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setState((s) => ({ ...s, status: 'errored' }));
        }
      });
    })();

    return () => {
      cancelled = true;
      if (channel !== null) void supabase.removeChannel(channel);
    };
  }, [meetingId, orgId, dispatch]);

  // Content poll. Realtime broadcast delivery to the browser has proven
  // unreliable in practice: the bot-worker's sends succeed (broadcasted: true),
  // but live events often don't reach the subscribed channel — only the
  // on-subscribe reconnect-fetch delivered them, so cards / syntheses /
  // transcript appeared only on a manual refresh. Poll meeting_events on a
  // short interval and replay anything new through the same reconnect path so
  // the live page updates within a couple of seconds on its own. Idempotent:
  // each poll fetches only event_id > lastSeen, and the reducer is replay-safe.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void reconnectFetch({
        orgId,
        meetingId,
        afterEventId: lastSeenRef.current,
        dispatch,
        onMaxEventId: (id) => {
          if (id > lastSeenRef.current) lastSeenRef.current = id;
        },
        onMeetingStatus: (live) => {
          setState((s) => (s.liveMeetingStatus === live ? s : { ...s, liveMeetingStatus: live }));
        },
      });
    }, CONTENT_POLL_MS);
    return () => window.clearInterval(interval);
  }, [meetingId, orgId, dispatch]);

  // Polling fallback for status transitions. The Realtime broadcast +
  // reconnect-fetch SHOULD be enough on its own, but live testing has
  // shown the joining-shell occasionally stays stuck even after the bot
  // started recording — root cause is suspected to be a private-channel
  // auth timing edge but isn't pinned down yet. Poll meetings.status
  // every 3s while the page hasn't seen a live=recording status yet, so
  // the page is guaranteed to flip out of JoiningShell within ~3s of
  // the bot starting to record, regardless of broadcast delivery.
  // Stops polling the moment liveMeetingStatus becomes anything (live
  // path took over) OR we observe 'recording' (we no longer need to
  // poll). Cheap query (~1 row, indexed lookup).
  useEffect(() => {
    if (state.liveMeetingStatus !== null) return;
    let cancelled = false;
    const supabase = getBrowserClient();
    const interval = window.setInterval(() => {
      void (async () => {
        const { data } = await supabase
          .from('meetings')
          .select('status')
          .eq('meeting_id', meetingId)
          .maybeSingle();
        if (cancelled) return;
        const s = (data?.status as BroadcastedStatus | null) ?? null;
        if (s === null) return;
        setState((prev) => (prev.liveMeetingStatus === s ? prev : { ...prev, liveMeetingStatus: s }));
        dispatch({
          type: 'meetingStatus',
          mode: s === 'recording' ? 'live' : 'idle',
        });
      })();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [meetingId, dispatch, state.liveMeetingStatus]);

  return state;
}

/**
 * Translate a broadcast event into a reducer action (where there's a
 * mapping) and update the meeting-status side-channel for status events.
 * Unknown event types are dropped silently — the bot-worker may emit
 * transcript.* messages we don't reduce yet.
 */
export function dispatchBroadcast(
  eventType: string,
  payload: Record<string, unknown>,
  dispatch: (action: AppAction) => void,
  setState: React.Dispatch<React.SetStateAction<ChannelState>>,
  /** True only for the LIVE Realtime broadcast path. Interim (partial)
   *  transcript events are transient and dispatched ONLY when live; the
   *  reconnect/poll replay path (default false) drops them so persisted
   *  historical partials never re-render. */
  fromLiveBroadcast = false,
): void {
  switch (eventType) {
    case 'meetingStatus': {
      const status = payload['status'] as BroadcastedStatus | undefined;
      if (status === undefined) return;
      setState((s) => (s.liveMeetingStatus === status ? s : { ...s, liveMeetingStatus: status }));
      // Map to reducer's two-state meeting field.
      dispatch({
        type: 'meetingStatus',
        mode: status === 'recording' ? 'live' : 'idle',
      });
      return;
    }
    case 'card':
      if (isCardEvent(payload['card'])) {
        dispatch({ type: 'card', card: payload['card'] });
      }
      return;
    case 'cardUpdated': {
      const update = payload['update'];
      if (!isObject(update)) return;
      // Pin updates from card-actions-server come through cardUpdated
      // with {cardId, pinned}. Route those to the cardPinned reducer
      // action since the regular cardUpdated path doesn't mutate the
      // CardRecord.pinned flag.
      const u = update as { cardId?: string; pinned?: boolean };
      if (typeof u.cardId === 'string' && typeof u.pinned === 'boolean') {
        dispatch({ type: 'cardPinned', cardId: u.cardId, pinned: u.pinned });
        return;
      }
      dispatch({ type: 'cardUpdated', update: update as never });
      return;
    }
    case 'cardRetracted':
      if (isObject(payload['retracted'])) {
        dispatch({ type: 'cardRetracted', retracted: payload['retracted'] as never });
      }
      return;
    case 'synthesisStart':
      if (isObject(payload['start'])) {
        dispatch({ type: 'synthesisStart', start: payload['start'] as never });
      }
      return;
    case 'synthesisDelta':
      if (isObject(payload['delta'])) {
        dispatch({ type: 'synthesisDelta', delta: payload['delta'] as never });
      }
      return;
    case 'synthesisDone':
      if (isObject(payload['done'])) {
        dispatch({ type: 'synthesisDone', done: payload['done'] as never });
      }
      return;
    case 'synthesisError':
      if (isObject(payload['error'])) {
        dispatch({ type: 'synthesisError', error: payload['error'] as never });
      }
      return;
    case 'synthesisRetracted':
      if (isObject(payload['retracted'])) {
        dispatch({ type: 'synthesisRetracted', retracted: payload['retracted'] as never });
      }
      return;
    case 'transcript.data': {
      const utterance = toTranscriptUtterance(payload, true);
      if (utterance !== null) dispatch({ type: 'transcriptUtterance', utterance });
      return;
    }
    case 'transcript.partial_data': {
      // Interim utterances are transient: the bot-worker broadcasts them as
      // TRANSIENT Realtime events with a STABLE utteranceId (shared with the
      // eventual final) and a monotonic revision, so the live line can morph
      // word-by-word and then settle in place when the final arrives.
      //
      // LIVE-ONLY: only dispatch on the live broadcast path. On the
      // reconnect/poll replay path any persisted historical partials must stay
      // suppressed (they have drifting timestamps / are superseded by finals),
      // so we drop them. Interims carry no persisted eventId, so the caller
      // never advances lastSeenRef on them.
      if (!fromLiveBroadcast) return;
      const utterance = toTranscriptUtterance(payload, false);
      if (utterance !== null) dispatch({ type: 'transcriptUtterance', utterance });
      return;
    }
    default:
      return;
  }
}

/**
 * Map a transcript.data / transcript.partial_data broadcast payload
 * (utteranceToEventPayload from the bot-worker) into the reducer's
 * TranscriptUtterance. The two events share an identical payload shape; the
 * caller passes `isFinal` (true for transcript.data, false for the partial).
 * A partial and its eventual final share a STABLE utteranceId, so the reducer
 * merges them in place. Returns null when the payload is missing required
 * fields.
 */
function toTranscriptUtterance(
  payload: Record<string, unknown>,
  isFinal: boolean,
): TranscriptUtterance | null {
  const utteranceId = payload['utteranceId'];
  const text = payload['text'];
  if (typeof utteranceId !== 'string' || typeof text !== 'string') return null;
  const speaker = typeof payload['speaker'] === 'string' ? payload['speaker'] : null;
  const startMs = typeof payload['startMs'] === 'number' ? payload['startMs'] : 0;
  const endMs = typeof payload['endMs'] === 'number' ? payload['endMs'] : startMs;
  const revision = typeof payload['revision'] === 'number' ? payload['revision'] : 0;
  return { utteranceId, text, speaker, isFinal, startMs, endMs, revision };
}

async function reconnectFetch(args: {
  orgId: string;
  meetingId: string;
  afterEventId: number;
  dispatch: (action: AppAction) => void;
  onMaxEventId: (id: number) => void;
  onMeetingStatus: (s: BroadcastedStatus) => void;
}): Promise<void> {
  // Go through the server route (NOT a direct meeting_events read) so transcript
  // text — encrypted at rest and stripped from the payload — comes back
  // decrypted. A client-side read can't decrypt, so it could never surface live
  // transcript; only the server seed could, which is why transcript needed a
  // refresh. The route returns broadcast-shaped payloads so the mapping below is
  // unchanged.
  let body: { events?: { event_id: number; type: string; payload: Record<string, unknown> }[] };
  try {
    const res = await fetch(
      `/api/meetings/${encodeURIComponent(args.meetingId)}/events?after=${String(args.afterEventId)}`,
      { headers: { accept: 'application/json' } },
    );
    if (!res.ok) {
      console.warn('[realtime-meeting-channel] reconnect-fetch failed:', res.status);
      return;
    }
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn('[realtime-meeting-channel] reconnect-fetch error:', err);
    return;
  }
  for (const row of body.events ?? []) {
    dispatchBroadcast(row.type, row.payload, args.dispatch, (s) => {
      const next = typeof s === 'function' ? s({ status: 'subscribed', liveMeetingStatus: null }) : s;
      if (next.liveMeetingStatus !== null) args.onMeetingStatus(next.liveMeetingStatus);
    });
    args.onMaxEventId(row.event_id);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCardEvent(v: unknown): v is never {
  // Loose shape check — the reducer trusts its action payloads. If
  // the bot-worker sends malformed cards, we'd rather crash visibly
  // in the reducer than silently drop. Here we just gate on object.
  return isObject(v);
}
