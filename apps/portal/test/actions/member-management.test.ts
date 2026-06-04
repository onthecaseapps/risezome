import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireAdmin = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// member-actions imports requireAdmin (the admin-power gate; requireManager is an
// alias of it). Mock the actual imported name.
vi.mock('../../app/_lib/auth', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import {
  changeRoleAction,
  removeMemberAction,
  setCanInviteBotAction,
} from '../../app/(authed)/members/member-actions';

/**
 * @param error  optional message returned by update/delete (simulates a trigger).
 * @param targetRole  the CURRENT role of the member being changed (the row
 *   changeRoleAction reads for the audit detail + the super_admin gate). Defaults
 *   to 'member'.
 */
function makeService(error?: string, targetRole = 'member'): unknown {
  const terminal = async () => ({ error: error !== undefined ? { message: error } : null });
  return {
    from(table: string) {
      // changeRoleAction (U5) reads the member's current role for the audit
      // detail + the super_admin gate, then appends a permission_audit_log row
      // (best-effort). Provide a select chain ending in maybeSingle and an
      // insert that succeeds.
      if (table === 'permission_audit_log') {
        return { insert: async () => ({ error: null }) };
      }
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: targetRole } }) }) }),
        }),
        update: () => ({ eq: () => ({ eq: terminal }) }),
        delete: () => ({ eq: () => ({ eq: terminal }) }),
      };
    },
  };
}

beforeEach(() => {
  // Default caller is a plain Admin (manager).
  requireAdmin.mockResolvedValue({ orgId: 'org_1', user: { id: 'mgr_1' }, role: 'manager' });
});
afterEach(() => vi.clearAllMocks());

describe('member-management actions', () => {
  it('changeRoleAction rejects an invalid role', async () => {
    const result = await changeRoleAction('u2', 'superadmin');
    expect(result).toEqual({ ok: false, error: 'invalid_role' });
  });

  it('changeRoleAction succeeds for a valid role', async () => {
    createServiceRoleClient.mockReturnValue(makeService());
    expect(await changeRoleAction('u2', 'manager')).toEqual({ ok: true });
  });

  it('changeRoleAction maps the last-manager trigger error', async () => {
    createServiceRoleClient.mockReturnValue(
      makeService('cannot remove or demote the last manager of a workspace'),
    );
    expect(await changeRoleAction('u2', 'member')).toEqual({ ok: false, error: 'last_manager' });
  });

  it('changeRoleAction maps the last-super_admin trigger error', async () => {
    // A super_admin caller demoting a super_admin; the trigger blocks the last one.
    requireAdmin.mockResolvedValue({ orgId: 'org_1', user: { id: 'sa_1' }, role: 'super_admin' });
    createServiceRoleClient.mockReturnValue(
      makeService('cannot remove or demote the last super_admin of a workspace', 'super_admin'),
    );
    expect(await changeRoleAction('u2', 'member')).toEqual({ ok: false, error: 'last_super_admin' });
  });

  it('P1-A: a manager(Admin) caller CANNOT grant super_admin (forbidden)', async () => {
    // Caller is a manager (default). Granting the master-key tier must be refused.
    createServiceRoleClient.mockReturnValue(makeService());
    expect(await changeRoleAction('u2', 'super_admin')).toEqual({ ok: false, error: 'forbidden' });
  });

  it('P1-A: a manager(Admin) caller CANNOT demote an existing super_admin (forbidden)', async () => {
    // Target is currently super_admin; only another super_admin may remove that tier.
    createServiceRoleClient.mockReturnValue(makeService(undefined, 'super_admin'));
    expect(await changeRoleAction('u2', 'manager')).toEqual({ ok: false, error: 'forbidden' });
  });

  it('P1-A: a super_admin caller CAN grant super_admin', async () => {
    requireAdmin.mockResolvedValue({ orgId: 'org_1', user: { id: 'sa_1' }, role: 'super_admin' });
    createServiceRoleClient.mockReturnValue(makeService());
    expect(await changeRoleAction('u2', 'super_admin')).toEqual({ ok: true });
  });

  it('P1-A: a manager(Admin) caller CAN still move member <-> manager', async () => {
    createServiceRoleClient.mockReturnValue(makeService());
    expect(await changeRoleAction('u2', 'manager')).toEqual({ ok: true });
  });

  it('setCanInviteBotAction succeeds', async () => {
    createServiceRoleClient.mockReturnValue(makeService());
    expect(await setCanInviteBotAction('u2', true)).toEqual({ ok: true });
  });

  it('removeMemberAction maps the last-manager trigger error', async () => {
    createServiceRoleClient.mockReturnValue(
      makeService('cannot remove or demote the last manager of a workspace'),
    );
    expect(await removeMemberAction('mgr_1')).toEqual({ ok: false, error: 'last_manager' });
  });
});
