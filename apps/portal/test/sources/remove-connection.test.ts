import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const requireAdmin = vi.fn();
const createServiceRoleClient = vi.fn();
const removeSourceFromTeam = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));
vi.mock('../../app/_lib/team-source-lifecycle', () => ({
  removeSourceFromTeam: (...a: unknown[]) => removeSourceFromTeam(...a),
}));

import { removeConnectionFromTeamAction } from '../../app/(authed)/sources/remove-connection-action';

/**
 * Chainable Supabase stub.
 *   - sources lookups resolve a fixed id list (for the org-scoping filter and
 *     the credential's connSourceIds query).
 *   - the connection table (trello/atlassian) resolves a credential row.
 *   - team_sources head-count resolves `refCount` (sources still referenced by
 *     a team after removal) — drives the disconnect decision.
 *   - records every credential-table delete/update so tests can assert whether
 *     the connection was disconnected.
 */
function makeSupabase(opts: {
  sourceIds?: string[];
  connection?: { id: string } | null;
  refCount?: number;
  deletes?: string[];
  updates?: { table: string; vals: Record<string, unknown> }[];
}): unknown {
  const sourceIds = opts.sourceIds ?? [];
  const connection = opts.connection ?? { id: 'conn_1' };
  const refCount = opts.refCount ?? 0;

  return {
    from(table: string) {
      if (table === 'trello_connections' || table === 'atlassian_connections') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: connection, error: null }) }) }),
          delete: () => ({
            eq: async () => {
              opts.deletes?.push(table);
              return { error: null };
            },
          }),
        };
      }
      if (table === 'github_installations') {
        return {
          update: (vals: Record<string, unknown>) => ({
            eq: () => ({
              eq: async () => {
                opts.updates?.push({ table, vals });
                return { error: null };
              },
            }),
          }),
        };
      }
      if (table === 'team_sources') {
        // head-count select → { count }
        return { select: () => ({ in: async () => ({ count: refCount, error: null }) }) };
      }
      // sources: select(...).in(...).eq(...) OR select(...).eq(...).eq(...)
      const rows = sourceIds.map((id) => ({ id }));
      const result = { data: rows, error: null };
      const chain: Record<string, unknown> = {
        in: () => chain,
        eq: () => chain,
        then: undefined,
      };
      // make the chain awaitable at any depth
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(result);
      return { select: () => chain };
    },
  };
}

beforeEach(() => {
  requireAdmin.mockResolvedValue({ orgId: 'org_1' });
});
afterEach(() => vi.clearAllMocks());

describe('removeConnectionFromTeamAction', () => {
  it('de-indexes every source and disconnects the connection when this is the last team', async () => {
    removeSourceFromTeam.mockResolvedValue({ deindexed: true });
    const deletes: string[] = [];
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ sourceIds: ['s1', 's2'], connection: { id: 'conn_1' }, refCount: 0, deletes }),
    );

    const res = await removeConnectionFromTeamAction({
      teamId: 't1',
      provider: 'confluence',
      sourceIds: ['s1', 's2'],
    });

    expect(res).toEqual({ ok: true, fullyRemoved: true, deindexed: 2, keptInUse: 0 });
    expect(removeSourceFromTeam).toHaveBeenCalledTimes(2);
    expect(deletes).toEqual(['atlassian_connections']); // credential row removed
  });

  it('keeps the connection and reports still-in-use when another team references a source', async () => {
    removeSourceFromTeam.mockResolvedValue({ deindexed: false }); // refcount stayed > 0
    const deletes: string[] = [];
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ sourceIds: ['s1', 's2'], connection: { id: 'conn_1' }, refCount: 2, deletes }),
    );

    const res = await removeConnectionFromTeamAction({
      teamId: 't1',
      provider: 'confluence',
      sourceIds: ['s1', 's2'],
    });

    expect(res).toEqual({ ok: true, fullyRemoved: false, deindexed: 0, keptInUse: 2 });
    expect(deletes).toEqual([]); // connection NOT disconnected — still in use
  });

  it('Atlassian: keeps the shared credential row when Jira sources are still referenced', async () => {
    // Removing Confluence de-indexes its own sources (last team for them), but
    // the atlassian_connections row is shared with Jira, whose sources are still
    // referenced (refCount > 0 across the connection) → do not disconnect.
    removeSourceFromTeam.mockResolvedValue({ deindexed: true });
    const deletes: string[] = [];
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ sourceIds: ['conf1'], connection: { id: 'conn_1' }, refCount: 1, deletes }),
    );

    const res = await removeConnectionFromTeamAction({
      teamId: 't1',
      provider: 'confluence',
      sourceIds: ['conf1'],
    });

    expect(res).toEqual({ ok: true, fullyRemoved: false, deindexed: 1, keptInUse: 0 });
    expect(deletes).toEqual([]); // shared Atlassian credential kept for Jira
  });

  it('GitHub: marks the installation removed (not deleted) when fully unused', async () => {
    removeSourceFromTeam.mockResolvedValue({ deindexed: true });
    const updates: { table: string; vals: Record<string, unknown> }[] = [];
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ sourceIds: ['r1'], refCount: 0, updates }),
    );

    const res = await removeConnectionFromTeamAction({
      teamId: 't1',
      provider: 'github',
      sourceIds: ['r1'],
      installationId: 42,
    });

    expect(res).toEqual({ ok: true, fullyRemoved: true, deindexed: 1, keptInUse: 0 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe('github_installations');
    expect(updates[0]!.vals).toHaveProperty('removed_at');
  });

  it('rejects when requireAdmin throws (non-admin)', async () => {
    requireAdmin.mockRejectedValue(new Error('redirect'));
    createServiceRoleClient.mockReturnValue(makeSupabase({}));
    await expect(
      removeConnectionFromTeamAction({ teamId: 't1', provider: 'confluence', sourceIds: ['s1'] }),
    ).rejects.toThrow('redirect');
    expect(removeSourceFromTeam).not.toHaveBeenCalled();
  });
});
