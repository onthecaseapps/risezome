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
  team_id?: string | null;
}

function makeService(opts: {
  invite: InviteRow | null;
  existingMember: boolean;
  /** When set, the teams lookup returns this live team; null ⇒ team gone/archived. */
  liveTeam?: { team_id: string } | null;
  /** When set, the org_members membership read fails with this error. */
  memberReadError?: { message: string };
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const insertOptions: Array<Record<string, unknown> | undefined> = [];
  const teamUpserts: Array<Record<string, unknown>> = [];
  const deletedTokens: string[] = [];
  const service = {
    inserted,
    insertOptions,
    teamUpserts,
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
      if (table === 'teams') {
        // The defensive re-check that the invite's team is still live.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({ data: opts.liveTeam ?? null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'team_members') {
        return {
          upsert: async (row: Record<string, unknown>) => {
            teamUpserts.push(row);
            return { error: null };
          },
        };
      }
      // org_members
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  opts.memberReadError === undefined && opts.existingMember
                    ? { user_id: 'user_1' }
                    : null,
                error: opts.memberReadError ?? null,
              }),
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>, options?: Record<string, unknown>) => {
          inserted.push(row);
          insertOptions.push(options);
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

  it('writes membership as an idempotent upsert (double-submit cannot surface join_failed)', async () => {
    const service = makeService({ invite: futureInvite(), existingMember: false });
    createServiceRoleClient.mockReturnValue(service);

    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/upcoming');
    expect(service.insertOptions).toEqual([{ onConflict: 'org_id,user_id', ignoreDuplicates: true }]);
  });

  it('propagates a failed membership read as retryable instead of falling into the insert path', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = makeService({
        invite: futureInvite(),
        existingMember: true,
        memberReadError: { message: 'db down' },
      });
      createServiceRoleClient.mockReturnValue(service);

      await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow(
        'REDIRECT:/invite/tok_1?error=membership_check_failed',
      );
      expect(service.inserted).toHaveLength(0); // no clobber of the existing member
      expect(service.deletedTokens).toHaveLength(0); // token kept for the retry
    } finally {
      consoleErr.mockRestore();
    }
  });

  it('assigns the new member to the invite team when it carries a live team_id', async () => {
    const service = makeService({
      invite: futureInvite({ role: 'member', team_id: 'team_1' }),
      existingMember: false,
      liveTeam: { team_id: 'team_1' },
    });
    createServiceRoleClient.mockReturnValue(service);

    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/upcoming');
    expect(service.inserted).toHaveLength(1); // org membership
    expect(service.teamUpserts).toEqual([{ team_id: 'team_1', user_id: 'user_1' }]);
  });

  it('skips team assignment when the invite team was archived/deleted (live re-check fails)', async () => {
    const service = makeService({
      invite: futureInvite({ role: 'member', team_id: 'team_1' }),
      existingMember: false,
      liveTeam: null, // gone or archived
    });
    createServiceRoleClient.mockReturnValue(service);

    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/upcoming');
    expect(service.inserted).toHaveLength(1); // still joins the org
    expect(service.teamUpserts).toHaveLength(0); // but no team membership
  });

  it('does not assign a team for an existing member (no-op join)', async () => {
    const service = makeService({
      invite: futureInvite({ role: 'member', team_id: 'team_1' }),
      existingMember: true,
      liveTeam: { team_id: 'team_1' },
    });
    createServiceRoleClient.mockReturnValue(service);

    await expect(acceptInviteAction(form('tok_1'))).rejects.toThrow('REDIRECT:/upcoming');
    expect(service.inserted).toHaveLength(0);
    expect(service.teamUpserts).toHaveLength(0);
  });
});
