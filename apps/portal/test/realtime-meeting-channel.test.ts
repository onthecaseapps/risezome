import { describe, it, expect } from 'vitest';
import {
  APPLIED_EVENT_IDS_CAP,
  createAppliedEventIds,
  dispatchBroadcast,
  markEventApplied,
  type ChannelState,
} from '../app/_lib/realtime-meeting-channel';
import type { AppAction } from '@risezome/hud-ui';

/**
 * Unit coverage for the broadcast → reducer-action / status mapping that
 * drives live updates on the live meeting page. The full hook wires the
 * Supabase realtime client; this exercises the pure routing the page depends
 * on (status liveness — U2 — plus card/synthesis routing).
 */

function harness() {
  const dispatched: AppAction[] = [];
  const dispatch = (a: AppAction): void => {
    dispatched.push(a);
  };
  let state: ChannelState = { status: 'subscribed', liveMeetingStatus: null };
  const setState: React.Dispatch<React.SetStateAction<ChannelState>> = (next) => {
    state = typeof next === 'function' ? (next as (s: ChannelState) => ChannelState)(state) : next;
  };
  return { dispatched, dispatch, setState, getState: () => state };
}

describe('dispatchBroadcast — meeting status liveness (U2)', () => {
  it('a recording meetingStatus broadcast flips liveMeetingStatus and dispatches live', () => {
    const h = harness();
    dispatchBroadcast('meetingStatus', { status: 'recording' }, h.dispatch, h.setState);
    expect(h.getState().liveMeetingStatus).toBe('recording');
    expect(h.dispatched).toContainEqual({ type: 'meetingStatus', mode: 'live' });
  });

  it('a non-recording status maps to idle and surfaces the status to the shell', () => {
    const h = harness();
    dispatchBroadcast('meetingStatus', { status: 'joining' }, h.dispatch, h.setState);
    expect(h.getState().liveMeetingStatus).toBe('joining');
    expect(h.dispatched).toContainEqual({ type: 'meetingStatus', mode: 'idle' });
  });

  it('a meetingStatus broadcast without a status is a no-op', () => {
    const h = harness();
    dispatchBroadcast('meetingStatus', {}, h.dispatch, h.setState);
    expect(h.getState().liveMeetingStatus).toBeNull();
    expect(h.dispatched).toHaveLength(0);
  });

  it('routes a synthesisStart broadcast to the reducer action', () => {
    const h = harness();
    const start = { synthesisId: 's1', sourceCardIds: ['c1'], traceId: 't1' };
    dispatchBroadcast('synthesisStart', { start }, h.dispatch, h.setState);
    expect(h.dispatched).toContainEqual({ type: 'synthesisStart', start });
  });

  it('drops unknown event types silently', () => {
    const h = harness();
    dispatchBroadcast('participant.join', { id: 'p1' }, h.dispatch, h.setState);
    expect(h.dispatched).toHaveLength(0);
  });

  it('dispatches a final transcript utterance', () => {
    const h = harness();
    dispatchBroadcast(
      'transcript.data',
      { utteranceId: 'u1', text: 'hello there', speaker: 'Alice', startMs: 100, endMs: 1200, revision: 0 },
      h.dispatch,
      h.setState,
    );
    expect(h.dispatched).toContainEqual({
      type: 'transcriptUtterance',
      utterance: { utteranceId: 'u1', text: 'hello there', speaker: 'Alice', isFinal: true, startMs: 100, endMs: 1200, revision: 0 },
    });
  });

  it('dispatches an interim transcript utterance on the LIVE broadcast path', () => {
    const h = harness();
    dispatchBroadcast(
      'transcript.partial_data',
      { utteranceId: 'u1', text: 'hel', speaker: 'Alice', startMs: 100, revision: 2 },
      h.dispatch,
      h.setState,
      true, // fromLiveBroadcast
    );
    expect(h.dispatched).toContainEqual({
      type: 'transcriptUtterance',
      utterance: {
        utteranceId: 'u1',
        text: 'hel',
        speaker: 'Alice',
        isFinal: false,
        startMs: 100,
        endMs: 100,
        revision: 2,
      },
    });
  });

  it('DROPS the same partial on the reconnect/poll path (persisted partials never re-render)', () => {
    const h = harness();
    // Default fromLiveBroadcast=false mirrors the reconnect/poll replay path.
    dispatchBroadcast(
      'transcript.partial_data',
      { utteranceId: 'u1', text: 'hel', speaker: 'Alice', startMs: 100, revision: 0 },
      h.dispatch,
      h.setState,
    );
    expect(h.dispatched).toHaveLength(0);
  });
});

describe('applied-event-ids set (F1/F2 — broadcast/poll dual-delivery dedup)', () => {
  it('the same event id applied twice is deduped (second delivery is detectable)', () => {
    const applied = createAppliedEventIds();
    expect(applied.set.has(42)).toBe(false);
    markEventApplied(applied, 42);
    expect(applied.set.has(42)).toBe(true);
    // The other path checks the set BEFORE dispatching — a second mark (e.g.
    // a buggy double-apply) stays a single entry, never duplicating FIFO slots.
    markEventApplied(applied, 42);
    expect(applied.set.size).toBe(1);
    expect(applied.fifo).toEqual([42]);
  });

  it('evicts FIFO past the cap so memory stays bounded', () => {
    const applied = createAppliedEventIds();
    for (let id = 1; id <= APPLIED_EVENT_IDS_CAP + 10; id++) {
      markEventApplied(applied, id);
    }
    expect(applied.set.size).toBe(APPLIED_EVENT_IDS_CAP);
    // Oldest ids evicted first; newest retained.
    expect(applied.set.has(1)).toBe(false);
    expect(applied.set.has(10)).toBe(false);
    expect(applied.set.has(11)).toBe(true);
    expect(applied.set.has(APPLIED_EVENT_IDS_CAP + 10)).toBe(true);
  });
});
