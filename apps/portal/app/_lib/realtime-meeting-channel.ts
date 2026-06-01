'use client';

import { useEffect, useRef, useState } from 'react';
import { getBrowserClient } from './supabase-browser';
import type { AppAction } from '@risezome/hud-ui';

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
    const channel = supabase.channel(topic, { config: { private: true } });

    setState((s) => ({ ...s, status: 'connecting' }));

    channel.on('broadcast', { event: '*' }, (event) => {
      const eventType = event.event;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const eventId = typeof payload['eventId'] === 'number' ? (payload['eventId'] as number) : null;
      if (eventId !== null && eventId > lastSeenRef.current) {
        lastSeenRef.current = eventId;
      }
      dispatchBroadcast(eventType, payload, dispatch, setState);
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

    return () => {
      void supabase.removeChannel(channel);
    };
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
function dispatchBroadcast(
  eventType: string,
  payload: Record<string, unknown>,
  dispatch: (action: AppAction) => void,
  setState: React.Dispatch<React.SetStateAction<ChannelState>>,
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
    case 'gap':
      if (isObject(payload['gap'])) {
        dispatch({ type: 'gap', gap: payload['gap'] as never });
      }
      return;
    // transcript.data / transcript.partial_data: not reduced today.
    default:
      return;
  }
}

async function reconnectFetch(args: {
  orgId: string;
  meetingId: string;
  afterEventId: number;
  dispatch: (action: AppAction) => void;
  onMaxEventId: (id: number) => void;
  onMeetingStatus: (s: BroadcastedStatus) => void;
}): Promise<void> {
  const supabase = getBrowserClient();
  const { data, error } = await supabase
    .from('meeting_events')
    .select('event_id, type, payload')
    .eq('meeting_id', args.meetingId)
    .eq('org_id', args.orgId)
    .gt('event_id', args.afterEventId)
    .order('event_id', { ascending: true });
  if (error !== null) {
     
    console.warn('[realtime-meeting-channel] reconnect-fetch failed:', error);
    return;
  }
  for (const row of data ?? []) {
    const eventId = row.event_id as number;
    const payload = (row.payload as Record<string, unknown> | null) ?? {};
    dispatchBroadcast(row.type as string, payload, args.dispatch, (s) => {
      const next = typeof s === 'function' ? s({ status: 'subscribed', liveMeetingStatus: null }) : s;
      if (next.liveMeetingStatus !== null) args.onMeetingStatus(next.liveMeetingStatus);
    });
    args.onMaxEventId(eventId);
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
