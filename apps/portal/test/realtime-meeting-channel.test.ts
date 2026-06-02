import { describe, it, expect } from 'vitest';
import { dispatchBroadcast, type ChannelState } from '../app/_lib/realtime-meeting-channel';
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
});
