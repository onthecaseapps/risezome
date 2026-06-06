import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const requireManager = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  headers: () =>
    Promise.resolve({
      get: (k: string) => (k === 'host' ? 'risezome.app' : k === 'x-forwarded-proto' ? 'https' : null),
    }),
}));
vi.mock('../../app/_lib/auth', () => ({
  requireManager: () => requireManager(),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { createInviteAction } from '../../app/(authed)/members/invite-action';

/**
 * @param liveTeam  the row the teams re-check returns; null ⇒ the requested team
 *   is not a live, non-archived team in this org (so team_id must persist null).
 */
function makeService(liveTeam: { team_id: string } | null) {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    from(table: string) {
      if (table === 'teams') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({ maybeSingle: async () => ({ data: liveTeam, error: null }) }),
              }),
            }),
          }),
        };
      }
      // org_invites
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return { error: null };
        },
      };
    },
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  requireManager.mockResolvedValue({ orgId: 'org_1', user: { id: 'mgr_1' } });
});
afterEach(() => vi.clearAllMocks());

describe('createInviteAction — team_id', () => {
  it('persists a validated, live team_id on the invite', async () => {
    const service = makeService({ team_id: 'team_1' });
    createServiceRoleClient.mockReturnValue(service);

    const result = await createInviteAction(form({ role: 'member', team_id: 'team_1' }));
    expect(result.ok).toBe(true);
    expect(service.inserted[0]).toMatchObject({ org_id: 'org_1', role: 'member', team_id: 'team_1' });
  });

  it('persists team_id null when the requested team is not a live org team', async () => {
    const service = makeService(null); // re-check finds no live team
    createServiceRoleClient.mockReturnValue(service);

    const result = await createInviteAction(form({ role: 'member', team_id: 'team_x' }));
    expect(result.ok).toBe(true);
    expect(service.inserted[0]).toMatchObject({ team_id: null });
  });

  it('persists team_id null when no team is chosen (blank / "all")', async () => {
    const service = makeService(null);
    createServiceRoleClient.mockReturnValue(service);

    const result = await createInviteAction(form({ role: 'member', team_id: 'all' }));
    expect(result.ok).toBe(true);
    expect(service.inserted[0]).toMatchObject({ team_id: null });
  });
});
