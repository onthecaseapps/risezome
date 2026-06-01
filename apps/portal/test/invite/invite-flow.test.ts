import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const requireAuthedUser = vi.fn();
const createServiceRoleClient = vi.fn();
const cookieSet = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`REDIRECT:${p}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ set: (...args: unknown[]) => cookieSet(...args) }),
}));
vi.mock('../../app/_lib/auth', () => ({
  requireAuthedUser: () => requireAuthedUser(),
  CURRENT_ORG_COOKIE: 'risezome.current_org_id',
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { acceptInviteAction } from '../../app/invite/[token]/accept-action';

interface InviteRow {
  token: string;
  org_id: string;
  role: string;
  can_invite_bot: boolean;
  expires_at: string;
}

function makeService(opts: { invite: InviteRow | null; existingMember: boolean }) {
  const inserted: Array<Record<string, unknown>> = [];
  const deletedTokens: string[] = [];
  const service = {
    inserted,
    deletedTokens,
    from(table: string) {
      if (table === 'org_invites') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.invite, error: null }) }) }),
          delete: () => ({
            eq: async (_col: string, val: string) => {
              deletedTokens.push(val);
              return { error: null };
            },
          }),
        };
      }
      // org_members
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.existingMember ? { user_id: 'user_1' } : null,
                error: null,
              }),
            }),
          }),
        }),
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return { error: null };
        },
      };
    },
  };
  return service;
}

function form(token: string, extra?: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set('token', token);
  for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
  return fd;
}

function futureInvite(over: Partial<InviteRow> = {}): InviteRow {
  return {
    token: 'tok_1',
    org_id: 'org_1',
    role: 'member',
    can_invite_bot: false,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  requireAuthedUser.mockResolvedValue({ id: 'user_1' });
});
afterEach(() => vi.clearAllMocks());

describe('acceptInviteAction', () => {
  it('creates membership with the role from the token row and redirects', async () => {
    const service = makeService({ invite: futureInvite({ role: 'member' }), existingMember: false });
    createServiceRoleClient.mockReturnValue(service);

    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/upcoming');
    expect(service.inserted).toHaveLength(1);
    expect(service.inserted[0]).toMatchObject({ org_id: 'org_1', user_id: 'user_1', role: 'member' });
    expect(service.deletedTokens).toContain('tok_1'); // single-use consume
  });

  it('ignores a tampered role in the request — uses only the token row', async () => {
    const service = makeService({ invite: futureInvite({ role: 'member' }), existingMember: false });
    createServiceRoleClient.mockReturnValue(service);

    // Attacker adds role=manager to the form; it must be ignored.
    await expect(acceptInviteAction(form('tok_1', { role: 'manager' }))).rejects.toThrow(
      'REDIRECT:/upcoming',
    );
    expect(service.inserted[0]).toMatchObject({ role: 'member' });
  });

  it('routes a manager invite to /sources', async () => {
    const service = makeService({ invite: futureInvite({ role: 'manager' }), existingMember: false });
    createServiceRoleClient.mockReturnValue(service);
    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/sources');
  });

  it('is a no-op for an existing member (no role clobber) but still consumes the token', async () => {
    const service = makeService({ invite: futureInvite({ role: 'manager' }), existingMember: true });
    createServiceRoleClient.mockReturnValue(service);
    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow(/REDIRECT:/);
    expect(service.inserted).toHaveLength(0); // existing member's role unchanged
    expect(service.deletedTokens).toContain('tok_1');
  });

  it('rejects an expired token without creating membership', async () => {
    const service = makeService({
      invite: futureInvite({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      existingMember: false,
    });
    createServiceRoleClient.mockReturnValue(service);
    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/invite/tok_1?error=expired');
    expect(service.inserted).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    const service = makeService({ invite: null, existingMember: false });
    createServiceRoleClient.mockReturnValue(service);
    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/invite/tok_1?error=invalid');
  });
});
