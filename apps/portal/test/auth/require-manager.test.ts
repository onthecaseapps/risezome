import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const getUser = vi.fn();
const orgMembersResult = vi.fn();
const cookieGet = vi.fn();

vi.mock('next/navigation', () => ({
  // redirect() throws in real Next; mirror that so callers short-circuit and
  // tests can assert the destination.
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: (k: string) => cookieGet(k) }),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServerClient: () =>
    Promise.resolve({
      auth: { getUser: () => getUser() },
      from: () => ({ select: () => ({ order: () => orgMembersResult() }) }),
    }),
}));

import { requireAuthedUserWithOrg, requireManager } from '../../app/_lib/auth';

function membershipRow(role: string, canInviteBot: boolean, orgId = 'org_1', name = 'Org One') {
  return { role, can_invite_bot: canInviteBot, org: { id: orgId, name } };
}

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: { id: 'user_1' } }, error: null });
  cookieGet.mockReturnValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('requireAuthedUserWithOrg role surfacing', () => {
  it('surfaces role and treats managers as implicitly able to invite the bot', async () => {
    orgMembersResult.mockResolvedValue({ data: [membershipRow('manager', false)], error: null });
    const ctx = await requireAuthedUserWithOrg();
    expect(ctx.role).toBe('manager');
    expect(ctx.canInviteBot).toBe(true); // implicit for managers even with flag false
  });

  it('reflects a member\'s can_invite_bot grant', async () => {
    orgMembersResult.mockResolvedValue({ data: [membershipRow('member', true)], error: null });
    const granted = await requireAuthedUserWithOrg();
    expect(granted.role).toBe('member');
    expect(granted.canInviteBot).toBe(true);

    orgMembersResult.mockResolvedValue({ data: [membershipRow('member', false)], error: null });
    const ungranted = await requireAuthedUserWithOrg();
    expect(ungranted.canInviteBot).toBe(false);
  });

  it('falls back to the first membership when the cookie points to a non-member org (no escalation)', async () => {
    cookieGet.mockReturnValue({ value: 'org_someone_else' });
    orgMembersResult.mockResolvedValue({ data: [membershipRow('member', false, 'org_1')], error: null });
    const ctx = await requireAuthedUserWithOrg();
    expect(ctx.orgId).toBe('org_1');
    expect(ctx.role).toBe('member');
  });
});

describe('requireManager', () => {
  it('resolves for a manager', async () => {
    orgMembersResult.mockResolvedValue({ data: [membershipRow('manager', true)], error: null });
    const ctx = await requireManager();
    expect(ctx.role).toBe('manager');
  });

  it('redirects a member to /upcoming', async () => {
    orgMembersResult.mockResolvedValue({ data: [membershipRow('member', true)], error: null });
    await expect(requireManager()).rejects.toThrow('REDIRECT:/upcoming');
  });
});
