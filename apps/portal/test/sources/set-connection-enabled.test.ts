import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireAdmin = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { setConnectionEnabledAction } from '../../app/(authed)/sources/set-connection-enabled-action';

/** Chainable Supabase stub: `sources` resolves the org-scoping lookup;
 *  `team_sources.update(...).eq(...).in(...)` records the write. */
function makeSupabase(opts: {
  orgSourceIds?: string[];
  updates?: { vals: Record<string, unknown>; teamId: unknown; sourceIds: unknown }[];
}): unknown {
  const orgSourceIds = opts.orgSourceIds ?? [];
  return {
    from(table: string) {
      if (table === 'sources') {
        const result = { data: orgSourceIds.map((id) => ({ id })), error: null };
        const chain: Record<string, unknown> = {
          in: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => void) => resolve(result),
        };
        return { select: () => chain };
      }
      // team_sources.update(vals).eq('team_id', teamId).in('source_id', ids)
      return {
        update: (vals: Record<string, unknown>) => ({
          eq: (_col: string, teamId: unknown) => ({
            in: async (_c: string, sourceIds: unknown) => {
              opts.updates?.push({ vals, teamId, sourceIds });
              return { error: null };
            },
          }),
        }),
      };
    },
  };
}

beforeEach(() => {
  requireAdmin.mockResolvedValue({ orgId: 'org_1' });
});
afterEach(() => vi.clearAllMocks());

describe('setConnectionEnabledAction', () => {
  it('flips team_sources.enabled for the org-owned sources (non-destructive)', async () => {
    const updates: { vals: Record<string, unknown>; teamId: unknown; sourceIds: unknown }[] = [];
    createServiceRoleClient.mockReturnValue(makeSupabase({ orgSourceIds: ['s1', 's2'], updates }));

    const res = await setConnectionEnabledAction({ teamId: 't1', sourceIds: ['s1', 's2'], enabled: false });

    expect(res).toEqual({ ok: true });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.vals).toEqual({ enabled: false });
    expect(updates[0]!.teamId).toBe('t1');
    expect(updates[0]!.sourceIds).toEqual(['s1', 's2']);
  });

  it('no-ops (no admin check, no write) when sourceIds is empty', async () => {
    const updates: { vals: Record<string, unknown>; teamId: unknown; sourceIds: unknown }[] = [];
    createServiceRoleClient.mockReturnValue(makeSupabase({ updates }));
    const res = await setConnectionEnabledAction({ teamId: 't1', sourceIds: [], enabled: true });
    expect(res).toEqual({ ok: true });
    expect(requireAdmin).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('only flips sources that belong to the caller org (org-scoping)', async () => {
    const updates: { vals: Record<string, unknown>; teamId: unknown; sourceIds: unknown }[] = [];
    // Caller passes s1 (theirs) + s_foreign (another org) — only s1 resolves.
    createServiceRoleClient.mockReturnValue(makeSupabase({ orgSourceIds: ['s1'], updates }));
    const res = await setConnectionEnabledAction({ teamId: 't1', sourceIds: ['s1', 's_foreign'], enabled: false });
    expect(res).toEqual({ ok: true });
    expect(updates[0]!.sourceIds).toEqual(['s1']);
  });

  it('rejects when requireAdmin throws (non-admin)', async () => {
    requireAdmin.mockRejectedValue(new Error('redirect'));
    createServiceRoleClient.mockReturnValue(makeSupabase({ orgSourceIds: ['s1'] }));
    await expect(
      setConnectionEnabledAction({ teamId: 't1', sourceIds: ['s1'], enabled: false }),
    ).rejects.toThrow('redirect');
  });
});
