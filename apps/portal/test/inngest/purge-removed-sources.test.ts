import { describe, expect, it } from 'vitest';
import {
  purgeRemovedSources,
  purgeGraceMs,
  type PurgeDb,
} from '../../src/inngest/functions/purge-removed-sources';

/**
 * Unit tests for the disconnected-source purge core (U7 / S7). The cascade that
 * actually clears docs/chunks/embeddings is a DB FK behaviour, verified
 * separately against the local stack; here we assert the query shape + count.
 */

function makeDb(result: { data: { id: string }[] | null; error: { message: string } | null }): {
  db: PurgeDb;
  calls: { table: string; eq: [string, unknown][]; lt: [string, unknown][] };
} {
  const calls = { table: '', eq: [] as [string, unknown][], lt: [] as [string, unknown][] };
  const db: PurgeDb = {
    from(table: string) {
      calls.table = table;
      return {
        delete() {
          return {
            eq(col: string, value: unknown) {
              calls.eq.push([col, value]);
              return {
                lt(col2: string, value2: unknown) {
                  calls.lt.push([col2, value2]);
                  return { select: () => Promise.resolve(result) };
                },
              };
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

describe('purgeRemovedSources (U7)', () => {
  it('deletes sources with status=removed older than the grace cutoff', async () => {
    const { db, calls } = makeDb({ data: [{ id: 's1' }, { id: 's2' }], error: null });
    const nowMs = Date.parse('2026-06-10T00:00:00Z');
    const graceMs = 7 * 24 * 60 * 60 * 1000;
    const res = await purgeRemovedSources(db, { nowMs, graceMs });

    expect(res.purged).toBe(2);
    expect(calls.table).toBe('sources');
    expect(calls.eq).toContainEqual(['status', 'removed']);
    // Cutoff is now - grace = 2026-06-03.
    expect(calls.lt[0]![0]).toBe('removed_at');
    expect(calls.lt[0]![1]).toBe('2026-06-03T00:00:00.000Z');
  });

  it('returns 0 when nothing is past the grace window', async () => {
    const { db } = makeDb({ data: [], error: null });
    const res = await purgeRemovedSources(db, { nowMs: Date.now(), graceMs: 0 });
    expect(res.purged).toBe(0);
  });

  it('throws on a delete error (so the cron retries)', async () => {
    const { db } = makeDb({ data: null, error: { message: 'boom' } });
    await expect(purgeRemovedSources(db, { nowMs: Date.now(), graceMs: 0 })).rejects.toThrow(
      /boom/,
    );
  });

  it('grace window is env-configurable, defaults to 7 days', () => {
    expect(purgeGraceMs({})).toBe(7 * 24 * 60 * 60 * 1000);
    expect(purgeGraceMs({ RISEZOME_SOURCE_PURGE_GRACE_DAYS: '2' })).toBe(2 * 24 * 60 * 60 * 1000);
    expect(purgeGraceMs({ RISEZOME_SOURCE_PURGE_GRACE_DAYS: '0' })).toBe(0);
    expect(purgeGraceMs({ RISEZOME_SOURCE_PURGE_GRACE_DAYS: 'junk' })).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });
});
