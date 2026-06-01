import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireManager = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireManager: () => requireManager() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import {
  changeRoleAction,
  removeMemberAction,
  setCanInviteBotAction,
} from '../../app/(authed)/members/member-actions';

function makeService(error?: string): unknown {
  const terminal = async () => ({ error: error !== undefined ? { message: error } : null });
  return {
    from() {
      return {
        update: () => ({ eq: () => ({ eq: terminal }) }),
        delete: () => ({ eq: () => ({ eq: terminal }) }),
      };
    },
  };
}

beforeEach(() => {
  requireManager.mockResolvedValue({ orgId: 'org_1', user: { id: 'mgr_1' } });
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
