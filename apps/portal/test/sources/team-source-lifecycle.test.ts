import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const createServiceRoleClient = vi.fn();
const inngestSend = vi.fn();

vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));
vi.mock('../../src/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => inngestSend(...a) },
}));

import { addSourceToTeam, removeSourceFromTeam } from '../../app/_lib/team-source-lifecycle';

interface SourceRow {
  id: string;
  kind: string;
  status: string;
  last_indexed_at: string | null;
  removed_at: string | null;
}

/** Minimal chainable stub for the lifecycle's three query shapes:
 *  sources select/update, team_sources insert/delete/count. */
function makeDb(source: SourceRow | null, opts: { refcount: number }) {
  const sourceUpdates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      if (table === 'sources') {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          maybeSingle: async () => ({ data: source, error: null }),
        };
        return {
          select: () => chain,
          update: (vals: Record<string, unknown>) => {
            sourceUpdates.push(vals);
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      if (table === 'team_sources') {
        return {
          insert: () => ({ select: async () => ({ data: [], error: null }) }),
          delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
          select: () => ({
            eq: async () => ({ count: opts.refcount, data: null, error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db, sourceUpdates };
}

beforeEach(() => {
  inngestSend.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('addSourceToTeam — revive', () => {
  it('revives a removed source: pending status, cleared tombstone, index event', async () => {
    const { db, sourceUpdates } = makeDb(
      { id: 's1', kind: 'trello', status: 'removed', last_indexed_at: '2026-06-01', removed_at: '2026-06-07' },
      { refcount: 1 },
    );
    createServiceRoleClient.mockReturnValue(db);

    const res = await addSourceToTeam({ orgId: 'o1', teamId: 't1', sourceId: 's1' });

    expect(res.indexed).toBe(true);
    expect(sourceUpdates).toContainEqual(
      expect.objectContaining({ status: 'pending', removed_at: null }),
    );
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'risezome/trello.index-requested' }),
    );
  });

  it('revives when removed_at is set even if status was stomped to pending (regression)', async () => {
    // The ensureSourceId stomp bug: a caller reset status='pending' before
    // this ran, so the old status==='removed' check concluded "nothing to
    // do" — removed_at survived as a landmine and no reindex was emitted.
    // The tombstone itself must mark the source as needing a revive.
    const { db, sourceUpdates } = makeDb(
      { id: 's1', kind: 'trello', status: 'pending', last_indexed_at: '2026-06-01', removed_at: '2026-06-07' },
      { refcount: 1 },
    );
    createServiceRoleClient.mockReturnValue(db);

    const res = await addSourceToTeam({ orgId: 'o1', teamId: 't1', sourceId: 's1' });

    expect(res.indexed).toBe(true);
    expect(sourceUpdates).toContainEqual(
      expect.objectContaining({ status: 'pending', removed_at: null }),
    );
    expect(inngestSend).toHaveBeenCalled();
  });

  it('second team referencing a live indexed source is a join-only no-op', async () => {
    const { db, sourceUpdates } = makeDb(
      { id: 's1', kind: 'trello', status: 'idle', last_indexed_at: '2026-06-01', removed_at: null },
      { refcount: 2 },
    );
    createServiceRoleClient.mockReturnValue(db);

    const res = await addSourceToTeam({ orgId: 'o1', teamId: 't2', sourceId: 's1' });

    expect(res.indexed).toBe(false);
    expect(sourceUpdates).toEqual([]);
    expect(inngestSend).not.toHaveBeenCalled();
  });
});

describe('removeSourceFromTeam', () => {
  it('marks removed with a tombstone when the refcount hits zero', async () => {
    const { db, sourceUpdates } = makeDb(
      { id: 's1', kind: 'trello', status: 'idle', last_indexed_at: '2026-06-01', removed_at: null },
      { refcount: 0 },
    );
    createServiceRoleClient.mockReturnValue(db);

    const res = await removeSourceFromTeam({ orgId: 'o1', teamId: 't1', sourceId: 's1' });

    expect(res.deindexed).toBe(true);
    const upd = sourceUpdates.find((u) => u['status'] === 'removed');
    expect(upd).toBeDefined();
    expect(typeof upd?.['removed_at']).toBe('string');
  });

  it('keeps the source live while other teams still reference it', async () => {
    const { db, sourceUpdates } = makeDb(
      { id: 's1', kind: 'trello', status: 'idle', last_indexed_at: '2026-06-01', removed_at: null },
      { refcount: 1 },
    );
    createServiceRoleClient.mockReturnValue(db);

    const res = await removeSourceFromTeam({ orgId: 'o1', teamId: 't1', sourceId: 's1' });

    expect(res.deindexed).toBe(false);
    expect(sourceUpdates).toEqual([]);
  });
});
