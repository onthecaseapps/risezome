import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getValidAtlassianToken } from '../../app/_lib/atlassian-token';
import { AtlassianAuthError } from '../../app/_lib/atlassian';

beforeAll(() => {
  process.env['ATLASSIAN_CLIENT_ID'] = 'cid';
  process.env['ATLASSIAN_CLIENT_SECRET'] = 'csec';
});
afterEach(() => vi.restoreAllMocks());

interface Conn {
  id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  cloud_id: string;
  site_url: string | null;
}

/** Stateful Supabase stub: read + guarded update of one connection row. */
function makeService(initial: Conn): { service: SupabaseClient; current: () => Conn } {
  let row = { ...initial };
  const service = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) };
        },
        update(patch: Partial<Conn>) {
          return {
            eq() {
              return {
                eq(_col: string, oldRefresh: string) {
                  return {
                    select: async () => {
                      if (oldRefresh === row.refresh_token) {
                        row = { ...row, ...patch };
                        return { data: [{ id: row.id }], error: null };
                      }
                      return { data: [], error: null }; // lost the guard race
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { service, current: () => row };
}

function refreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, scope: 's' }),
    { status: 200 },
  );
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

describe('getValidAtlassianToken', () => {
  it('returns the stored access token without refreshing when unexpired', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { service } = makeService({
      id: 'c1', access_token: 'AT', refresh_token: 'RT', expires_at: future(), cloud_id: 'cloud', site_url: 'u',
    });
    const tok = await getValidAtlassianToken('org', service);
    expect(tok).toEqual({ accessToken: 'AT', cloudId: 'cloud', siteUrl: 'u' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes when expired and atomically persists the rotated tokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(refreshResponse('AT2', 'RT2'));
    const { service, current } = makeService({
      id: 'c1', access_token: 'AT', refresh_token: 'RT', expires_at: past(), cloud_id: 'cloud', site_url: null,
    });
    const tok = await getValidAtlassianToken('org', service);
    expect(tok.accessToken).toBe('AT2');
    expect(current().refresh_token).toBe('RT2'); // rotated + persisted
    expect(current().access_token).toBe('AT2');
  });

  it('coalesces concurrent refreshes into a single token request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refreshResponse('AT2', 'RT2'));
    const { service } = makeService({
      id: 'c1', access_token: 'AT', refresh_token: 'RT', expires_at: past(), cloud_id: 'cloud', site_url: null,
    });
    const [a, b] = await Promise.all([
      getValidAtlassianToken('org', service),
      getValidAtlassianToken('org', service),
    ]);
    expect(a.accessToken).toBe('AT2');
    expect(b.accessToken).toBe('AT2');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // single refresh
  });

  it('propagates AtlassianAuthError when the refresh token is dead', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const { service } = makeService({
      id: 'c1', access_token: 'AT', refresh_token: 'RT', expires_at: past(), cloud_id: 'cloud', site_url: null,
    });
    await expect(getValidAtlassianToken('org', service)).rejects.toBeInstanceOf(AtlassianAuthError);
  });
});
