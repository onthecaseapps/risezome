import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AtlassianAuthError,
  buildAtlassianAuthorizeUrl,
  exchangeAtlassianCode,
  fetchAccessibleResources,
  refreshAtlassianToken,
} from '../../app/_lib/atlassian';

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

afterEach(() => vi.restoreAllMocks());

describe('buildAtlassianAuthorizeUrl', () => {
  it('includes the required audience, read scopes, offline_access, and consent prompt', () => {
    const url = new URL(
      buildAtlassianAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://app/api/atlassian/callback',
        state: 'st1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.atlassian.com/authorize');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('st1');
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('read:jira-work');
    expect(scope).toContain('read:confluence-content.all');
    expect(scope).toContain('offline_access');
  });
});

describe('exchangeAtlassianCode', () => {
  it('returns a token set with an absolute expiry computed from expires_in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'read:jira-work' }),
    );
    const set = await exchangeAtlassianCode({
      code: 'c',
      redirectUri: 'r',
      clientId: 'id',
      clientSecret: 'sec',
      now: 1000,
    });
    expect(set.accessToken).toBe('at');
    expect(set.refreshToken).toBe('rt');
    expect(set.expiresAt).toBe(1000 + 3600 * 1000);
  });

  it('throws on a non-200 exchange', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(
      exchangeAtlassianCode({ code: 'c', redirectUri: 'r', clientId: 'id', clientSecret: 'sec' }),
    ).rejects.toThrow();
  });
});

describe('refreshAtlassianToken', () => {
  it('returns a rotated token set on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' }),
    );
    const set = await refreshAtlassianToken({ refreshToken: 'rt1', clientId: 'id', clientSecret: 'sec', now: 0 });
    expect(set.accessToken).toBe('at2');
    expect(set.refreshToken).toBe('rt2'); // rotated — new refresh token
  });

  it('raises AtlassianAuthError on invalid_grant (stale/expired refresh)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    await expect(
      refreshAtlassianToken({ refreshToken: 'dead', clientId: 'id', clientSecret: 'sec' }),
    ).rejects.toBeInstanceOf(AtlassianAuthError);
  });
});

describe('fetchAccessibleResources', () => {
  it('maps resources to { cloudId, name, url }', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json([{ id: 'cloud_1', name: 'acme', url: 'https://acme.atlassian.net' }]),
    );
    const resources = await fetchAccessibleResources('at');
    expect(resources).toEqual([{ cloudId: 'cloud_1', name: 'acme', url: 'https://acme.atlassian.net' }]);
  });

  it('raises AtlassianAuthError on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
    await expect(fetchAccessibleResources('bad')).rejects.toBeInstanceOf(AtlassianAuthError);
  });
});
