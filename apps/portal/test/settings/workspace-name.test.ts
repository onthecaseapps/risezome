import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const requireManager = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({
  requireManager: () => requireManager(),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { updateWorkspaceNameAction } from '../../app/(authed)/settings/workspace/save-action';

/** Captures the orgs UPDATE payload + the id it was scoped to. */
function makeService() {
  const calls: { update: Record<string, unknown>; id: string }[] = [];
  return {
    calls,
    from(_table: string) {
      return {
        update(row: Record<string, unknown>) {
          return {
            eq: async (_col: string, id: string) => {
              calls.push({ update: row, id });
              return { error: null };
            },
          };
        },
      };
    },
  };
}

describe('updateWorkspaceNameAction', () => {
  beforeEach(() => {
    requireManager.mockReset();
    createServiceRoleClient.mockReset();
    requireManager.mockResolvedValue({ orgId: 'org_1', orgName: 'Old Name', user: { id: 'u1' } });
  });

  it('rejects an empty / whitespace name and does NOT touch the DB', async () => {
    const service = makeService();
    createServiceRoleClient.mockReturnValue(service);
    expect(await updateWorkspaceNameAction('   ')).toEqual({ ok: false, error: 'empty_name' });
    expect(service.calls).toHaveLength(0);
  });

  it('rejects a name longer than 100 chars', async () => {
    const service = makeService();
    createServiceRoleClient.mockReturnValue(service);
    const r = await updateWorkspaceNameAction('x'.repeat(101));
    expect(r).toEqual({ ok: false, error: 'name_too_long' });
    expect(service.calls).toHaveLength(0);
  });

  it('updates orgs.name (trimmed), scoped to the caller org id', async () => {
    const service = makeService();
    createServiceRoleClient.mockReturnValue(service);
    const r = await updateWorkspaceNameAction('  New Workspace  ');
    expect(r).toEqual({ ok: true, name: 'New Workspace' });
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toEqual({ update: { name: 'New Workspace' }, id: 'org_1' });
  });
});
