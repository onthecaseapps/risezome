import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireAdmin = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { setOrgPrivacyConfig } from '../../app/(authed)/settings/privacy-action';

/** A service client whose org_privacy_config upsert succeeds. */
function makeService(): unknown {
  return {
    from() {
      return { upsert: async () => ({ error: null }) };
    },
  };
}

beforeEach(() => {
  requireAdmin.mockResolvedValue({ orgId: 'org_1', user: { id: 'mgr_1' }, role: 'manager' });
  createServiceRoleClient.mockReturnValue(makeService());
});
afterEach(() => vi.clearAllMocks());

describe('setOrgPrivacyConfig (P2 default<floor)', () => {
  it('rejects an unknown level', async () => {
    expect(await setOrgPrivacyConfig('nope', 'only_me')).toEqual({
      ok: false,
      error: 'invalid_level',
    });
  });

  it('rejects a default MORE private than the floor (rank(default) < rank(floor))', async () => {
    // default only_me (rank 0) is more private than floor only_teammates (rank 2).
    expect(await setOrgPrivacyConfig('only_me', 'only_teammates')).toEqual({
      ok: false,
      error: 'default_below_floor',
    });
    // And it never reaches the DB.
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('accepts a default at the floor', async () => {
    expect(await setOrgPrivacyConfig('only_participants', 'only_participants')).toEqual({ ok: true });
  });

  it('accepts a default LESS private than the floor', async () => {
    // default only_teammates (2) >= floor only_me (0): the library-by-default posture.
    expect(await setOrgPrivacyConfig('only_teammates', 'only_me')).toEqual({ ok: true });
  });
});
