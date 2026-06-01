import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reapStaleMeetings,
  recordingReapAfterMs,
  type ReaperDb,
} from '../../src/inngest/functions/reap-stale-meetings';

/**
 * Build a mock Supabase service whose three `from('meetings').update(...)`
 * chains resolve, in order, to the supplied results. Each chain ends in
 * `.select('meeting_id')`. Records the `update()` payloads for assertions.
 */
function makeService(results: { data: { meeting_id: string }[] | null; error: { message: string } | null }[]): {
  service: ReaperDb;
  updates: Record<string, unknown>[];
} {
  const updates: Record<string, unknown>[] = [];
  let call = 0;
  const service: ReaperDb = {
    from() {
      const result = results[call++] ?? { data: [], error: null };
      const chain = {
        not: () => chain,
        is: () => chain,
        lt: () => chain,
        select: () => Promise.resolve(result),
      };
      return {
        update(values: Record<string, unknown>) {
          updates.push(values);
          return {
            eq: () => chain,
            in: () => chain,
          };
        },
      };
    },
  };
  return { service, updates };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recordingReapAfterMs', () => {
  it('falls back to the launcher default (300s) + 15m buffer when env is unset', () => {
    expect(recordingReapAfterMs({})).toBe((300 + 15 * 60) * 1000);
  });

  it('uses RECALL_MAX_DURATION_SECONDS + buffer when set', () => {
    expect(recordingReapAfterMs({ RECALL_MAX_DURATION_SECONDS: '3600' })).toBe((3600 + 15 * 60) * 1000);
  });

  it('clamps to the 12h hard cap for a huge/misconfigured value', () => {
    expect(recordingReapAfterMs({ RECALL_MAX_DURATION_SECONDS: '999999999' })).toBe(12 * 60 * 60 * 1000);
  });

  it('falls back on a non-numeric value', () => {
    expect(recordingReapAfterMs({ RECALL_MAX_DURATION_SECONDS: 'nope' })).toBe((300 + 15 * 60) * 1000);
  });
});

describe('reapStaleMeetings', () => {
  it('completes stale recordings, fails stuck pre-recording, and notifies the bot-worker per reaped recording', async () => {
    const { service, updates } = makeService([
      { data: [{ meeting_id: 'm1' }, { meeting_id: 'm2' }], error: null }, // by started_at
      { data: [{ meeting_id: 'm3' }], error: null }, // by created_at (null started_at)
      { data: [{ meeting_id: 'm4' }], error: null }, // pre-recording → failed
    ]);
    const notified: string[] = [];

    const result = await reapStaleMeetings(service, {
      nowMs: Date.UTC(2026, 4, 31, 12, 0, 0),
      recordingReapAfterMs: 75 * 60 * 1000,
      notify: async (id) => {
        notified.push(id);
      },
    });

    expect(result).toEqual({ completed: 3, failedPrelaunch: 1 });
    // Only the two recording updates complete; the third fails.
    expect(updates[0]).toMatchObject({ status: 'completed' });
    expect(updates[1]).toMatchObject({ status: 'completed' });
    expect(updates[2]).toMatchObject({ status: 'failed', error_code: 'launch_timeout' });
    // bot-worker notified for the 3 reaped recordings, not the failed one.
    expect(notified.sort()).toEqual(['m1', 'm2', 'm3']);
  });

  it('no-ops cleanly when nothing is stuck', async () => {
    const { service } = makeService([
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]);
    const result = await reapStaleMeetings(service, {
      nowMs: Date.now(),
      recordingReapAfterMs: 75 * 60 * 1000,
      notify: async () => {
        throw new Error('should not notify when nothing reaped');
      },
    });
    expect(result).toEqual({ completed: 0, failedPrelaunch: 0 });
  });

  it('throws (lets Inngest retry) when a query errors', async () => {
    const { service } = makeService([{ data: null, error: { message: 'db down' } }]);
    await expect(
      reapStaleMeetings(service, {
        nowMs: Date.now(),
        recordingReapAfterMs: 75 * 60 * 1000,
        notify: async () => undefined,
      }),
    ).rejects.toThrow(/db down/);
  });
});
