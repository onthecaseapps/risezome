import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTrelloAuthorizeUrl,
  fetchTrelloMember,
  TrelloAuthError,
} from '../../app/_lib/trello';

describe('buildTrelloAuthorizeUrl', () => {
  it('requests a long-lived read token and carries the CSRF state in the return URL', () => {
    const url = new URL(
      buildTrelloAuthorizeUrl({
        apiKey: 'KEY123',
        returnUrl: 'https://app.risezome.app/sources/trello/callback',
        state: 'st_abc',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://trello.com/1/authorize');
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('expiration')).toBe('never');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('callback_method')).toBe('fragment');
    expect(url.searchParams.get('key')).toBe('KEY123');
    const returnUrl = url.searchParams.get('return_url') ?? '';
    expect(returnUrl).toContain('/sources/trello/callback');
    expect(new URL(returnUrl).searchParams.get('state')).toBe('st_abc');
  });
});

describe('fetchTrelloMember', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves the member id + username for a valid token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'mem_1', username: 'acme' }), { status: 200 }),
    );
    const member = await fetchTrelloMember('tok', 'key');
    expect(member).toEqual({ id: 'mem_1', username: 'acme' });
  });

  it('defaults username to null when absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'mem_2' }), { status: 200 }),
    );
    expect((await fetchTrelloMember('tok', 'key')).username).toBeNull();
  });

  it('raises TrelloAuthError on a 401 (revoked/invalid token)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('invalid token', { status: 401 }));
    await expect(fetchTrelloMember('bad', 'key')).rejects.toBeInstanceOf(TrelloAuthError);
  });

  it('throws a non-auth error on other non-OK responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(fetchTrelloMember('tok', 'key')).rejects.toThrow(/500/);
  });
});
