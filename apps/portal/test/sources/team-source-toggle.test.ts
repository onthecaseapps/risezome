import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const requireAdmin = vi.fn();
const createServiceRoleClient = vi.fn();
const addSourceToTeam = vi.fn();
const removeSourceFromTeam = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));
vi.mock('../../app/_lib/team-source-lifecycle', () => ({
  addSourceToTeam: (...a: unknown[]) => addSourceToTeam(...a),
  removeSourceFromTeam: (...a: unknown[]) => removeSourceFromTeam(...a),
}));

import { setItemForTeamAction } from '../../app/(authed)/sources/team-source-toggle-action';

/**
 * Chainable Supabase stub. Records source inserts so we can assert that GitHub
 * never creates a new row while Trello/Atlassian does (when none exists).
 */
function makeSupabase(opts: {
  /** existing source row id returned by the resolve lookup, or null. */
  existingSourceId?: string | null;
  /** connection row for trello/atlassian ensure-source. */
  connection?: { id: string } | null;
  inserts?: { count: number };
}): unknown {
  const existing = opts.existingSourceId ?? null;
  const connection = opts.connection ?? { id: 'conn_1' };
  const counters = opts.inserts ?? { count: 0 };

  return {
    from(table: string) {
      if (table === 'trello_connections' || table === 'atlassian_connections') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: connection, error: null }) }) }) };
      }
      // sources table. Build a query object whose .eq() chains and whose
      // .maybeSingle() resolves the existing-source lookup; insert/update too.
      const queryResult = { data: existing !== null ? { id: existing } : null, error: null };
      const chain: Record<string, unknown> = {
        eq: () => chain,
        not: () => chain,
        maybeSingle: async () => queryResult,
      };
      return {
        select: () => chain,
        insert: () => ({
          select: () => ({
            single: async () => {
              counters.count += 1;
              return { data: { id: `new_src_${counters.count}` }, error: null };
            },
          }),
        }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
    },
  };
}

beforeEach(() => {
  requireAdmin.mockResolvedValue({ orgId: 'org_1' });
  addSourceToTeam.mockResolvedValue({ indexed: true });
  removeSourceFromTeam.mockResolvedValue({ deindexed: true });
});
afterEach(() => vi.clearAllMocks());

describe('setItemForTeamAction (U4)', () => {
  it('GitHub check resolves the existing repo source and adds it — no new source row', async () => {
    const inserts = { count: 0 };
    createServiceRoleClient.mockReturnValue(makeSupabase({ existingSourceId: 'gh_src_1', inserts }));
    const res = await setItemForTeamAction({
      teamId: 't1',
      provider: 'github',
      externalId: 'acme/web',
      label: 'acme/web',
      installationId: 1,
      on: true,
    });
    expect(res).toEqual({ ok: true });
    expect(addSourceToTeam).toHaveBeenCalledWith({ orgId: 'org_1', teamId: 't1', sourceId: 'gh_src_1' });
    expect(inserts.count).toBe(0); // GitHub never inserts a source row
  });

  it('GitHub check on a repo with no source row returns source_not_found', async () => {
    createServiceRoleClient.mockReturnValue(makeSupabase({ existingSourceId: null }));
    const res = await setItemForTeamAction({
      teamId: 't1',
      provider: 'github',
      externalId: 'acme/ghost',
      label: 'acme/ghost',
      on: true,
    });
    expect(res).toEqual({ ok: false, error: 'source_not_found' });
    expect(addSourceToTeam).not.toHaveBeenCalled();
  });

  it('Trello check on a not-yet-selected board ensures a source row then adds', async () => {
    const inserts = { count: 0 };
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ existingSourceId: null, connection: { id: 'conn_1' }, inserts }),
    );
    const res = await setItemForTeamAction({
      teamId: 't1',
      provider: 'trello',
      externalId: 'board_1',
      label: 'Roadmap',
      on: true,
    });
    expect(res).toEqual({ ok: true });
    expect(inserts.count).toBe(1); // a new source row was ensured
    expect(addSourceToTeam).toHaveBeenCalledWith({
      orgId: 'org_1',
      teamId: 't1',
      sourceId: 'new_src_1',
    });
  });

  it('Jira check reuses an existing source row (no insert) then adds', async () => {
    const inserts = { count: 0 };
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ existingSourceId: 'jira_src_1', connection: { id: 'conn_1' }, inserts }),
    );
    const res = await setItemForTeamAction({
      teamId: 't1',
      provider: 'jira',
      externalId: 'PLAT',
      label: 'Platform',
      on: true,
    });
    expect(res).toEqual({ ok: true });
    expect(inserts.count).toBe(0);
    expect(addSourceToTeam).toHaveBeenCalledWith({
      orgId: 'org_1',
      teamId: 't1',
      sourceId: 'jira_src_1',
    });
  });

  it('uncheck resolves the source and removes it — never deletes the source row', async () => {
    createServiceRoleClient.mockReturnValue(makeSupabase({ existingSourceId: 'gh_src_1' }));
    const res = await setItemForTeamAction({
      teamId: 't1',
      provider: 'github',
      externalId: 'acme/web',
      label: 'acme/web',
      on: false,
    });
    expect(res).toEqual({ ok: true });
    expect(removeSourceFromTeam).toHaveBeenCalledWith({
      orgId: 'org_1',
      teamId: 't1',
      sourceId: 'gh_src_1',
    });
    expect(addSourceToTeam).not.toHaveBeenCalled();
  });

  it('toggling on is idempotent at the action layer (delegates to the lifecycle)', async () => {
    createServiceRoleClient.mockReturnValue(makeSupabase({ existingSourceId: 'gh_src_1' }));
    await setItemForTeamAction({ teamId: 't1', provider: 'github', externalId: 'acme/web', label: 'acme/web', on: true });
    await setItemForTeamAction({ teamId: 't1', provider: 'github', externalId: 'acme/web', label: 'acme/web', on: true });
    // The action calls addSourceToTeam each time; the lifecycle (mocked) owns
    // dedup. Two calls, same args — no error.
    expect(addSourceToTeam).toHaveBeenCalledTimes(2);
  });

  it('rejects when requireAdmin throws (non-admin)', async () => {
    requireAdmin.mockRejectedValue(new Error('redirect'));
    createServiceRoleClient.mockReturnValue(makeSupabase({ existingSourceId: 'gh_src_1' }));
    await expect(
      setItemForTeamAction({ teamId: 't1', provider: 'github', externalId: 'acme/web', label: 'acme/web', on: true }),
    ).rejects.toThrow('redirect');
    expect(addSourceToTeam).not.toHaveBeenCalled();
  });
});
