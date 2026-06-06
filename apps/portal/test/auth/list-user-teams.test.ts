import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const getUser = vi.fn();
const teamRows = vi.fn();
// Captures the column/value the query filtered on, so we can assert the
// membership scoping is applied (the team_members SELECT policy is org-scoped,
// so RLS alone would surface every team in the org — the .eq('user_id') filter
// is what narrows it to the caller's own teams).
let eqArgs: { col: string; val: unknown } | null = null;

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServerClient: () =>
    Promise.resolve({
      auth: { getUser: () => getUser() },
      from: () => ({
        select: () => ({
          eq: (col: string, val: unknown) => {
            eqArgs = { col, val };
            return { order: () => teamRows() };
          },
        }),
      }),
    }),
}));

import { listUserTeams } from '../../app/_lib/auth';

function row(team_id: string, slug: string, opts: Partial<{ org_id: string; archived_at: string | null }> = {}) {
  return {
    team: {
      team_id,
      name: slug,
      slug,
      org_id: opts.org_id ?? 'org_1',
      archived_at: opts.archived_at ?? null,
    },
  };
}

beforeEach(() => {
  eqArgs = null;
  getUser.mockResolvedValue({ data: { user: { id: 'user_1' } }, error: null });
});
afterEach(() => vi.clearAllMocks());

describe('listUserTeams', () => {
  it('filters the query by the authenticated user_id (not just RLS org scope)', async () => {
    teamRows.mockResolvedValue({ data: [row('t1', 'platform')], error: null });
    await listUserTeams('org_1');
    expect(eqArgs).toEqual({ col: 'user_id', val: 'user_1' });
  });

  it('returns the user\'s teams in the org, excluding archived + cross-org, deduped', async () => {
    teamRows.mockResolvedValue({
      data: [
        row('t1', 'platform'),
        row('t1', 'platform'), // duplicate co-member-style row → deduped
        row('t2', 'growth'),
        row('t3', 'archived', { archived_at: '2026-01-01' }), // excluded
        row('t4', 'other-org', { org_id: 'org_2' }), // excluded
      ],
      error: null,
    });
    const teams = await listUserTeams('org_1');
    expect(teams.map((t) => t.slug)).toEqual(['platform', 'growth']);
  });

  it('returns [] when the user is on no teams', async () => {
    teamRows.mockResolvedValue({ data: [], error: null });
    expect(await listUserTeams('org_1')).toEqual([]);
  });

  it('returns [] (and skips the query) when there is no authenticated user', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await listUserTeams('org_1')).toEqual([]);
    expect(eqArgs).toBeNull(); // never reached the query
  });

  it('returns [] on a query error', async () => {
    teamRows.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await listUserTeams('org_1')).toEqual([]);
  });
});
