import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Authed member with an active org — the connect route's first call.
vi.mock('../../app/_lib/auth', () => ({
  requireAuthedUserWithOrg: vi.fn(async () => ({ user: { id: 'u1' }, orgId: 'org1' })),
}));

// Service-role client whose pending_installations insert succeeds.
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => ({ insert: async () => ({ error: null }) }),
  }),
}));

import { GET } from '../../app/(authed)/sources/trello/connect/route';

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe('GET /sources/trello/connect', () => {
  it('redirects to /sources?error=trello_not_configured when TRELLO_API_KEY is unset (no 500)', async () => {
    delete process.env['TRELLO_API_KEY'];
    const res = await GET(new NextRequest('http://localhost:3000/sources/trello/connect'));
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.pathname).toBe('/sources');
    expect(url.searchParams.get('error')).toBe('trello_not_configured');
  });

  it('redirects to the Trello authorize page when configured', async () => {
    process.env['TRELLO_API_KEY'] = 'KEY123';
    const res = await GET(new NextRequest('http://localhost:3000/sources/trello/connect'));
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://trello.com/1/authorize')).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get('key')).toBe('KEY123');
    expect(url.searchParams.get('scope')).toBe('read');
  });
});
