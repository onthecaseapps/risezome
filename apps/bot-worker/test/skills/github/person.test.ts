import { describe, expect, it, vi } from 'vitest';
import { resolvePerson } from '../../../src/skills/github/person.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import { ConnectorAuthError, RateLimitedError } from '../../../src/skills/github/connector-errors.js';

const TOKEN = 'inst_tok';

function clientWith(fetchImpl: typeof fetch): GithubClient {
  return new GithubClient({ fetchImpl });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolvePerson', () => {
  it('literal lookup hit returns {login, resolved: literal}', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ login: 'Nath5' }))) as unknown as typeof fetch;
    const result = await resolvePerson(clientWith(fetchImpl), TOKEN, 'Nath5');
    expect(result).toEqual({ login: 'Nath5', resolved: 'literal' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('literal 404 then org-scoped search hit returns {login, resolved: search}', async () => {
    let call = 0;
    let searchUrl = '';
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
      searchUrl = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(jsonResponse({ items: [{ login: 'Nath5' }] }));
    }) as unknown as typeof fetch;
    const result = await resolvePerson(clientWith(fetchImpl), TOKEN, 'nathan', { orgs: ['acme'] });
    expect(result).toEqual({ login: 'Nath5', resolved: 'search' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The fallback search is scoped to the installation's account, never global.
    expect(decodeURIComponent(searchUrl).replace(/\+/g, ' ')).toContain('org:acme');
  });

  it('literal 404 + scoped search empty returns null', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(jsonResponse({ items: [] }));
    }) as unknown as typeof fetch;
    const result = await resolvePerson(clientWith(fetchImpl), TOKEN, 'ghost', { orgs: ['acme'] });
    expect(result).toBeNull();
  });

  it('literal 404 with NO org scope skips the global search entirely (returns null)', async () => {
    // An unscoped /search/users would resolve a spoken name to a global
    // stranger — wrong-person answers are worse than no resolution.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('not found', { status: 404 })),
    ) as unknown as typeof fetch;
    expect(await resolvePerson(clientWith(fetchImpl), TOKEN, 'nathan')).toBeNull();
    expect(await resolvePerson(clientWith(fetchImpl), TOKEN, 'nathan', { orgs: [] })).toBeNull();
    // Only the literal lookups fired — no /search/users call.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('drops org values that fail the login charset gate instead of interpolating them', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('not found', { status: 404 })),
    ) as unknown as typeof fetch;
    const result = await resolvePerson(clientWith(fetchImpl), TOKEN, 'nathan', {
      orgs: ['bad org:injection'],
    });
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // literal only; no search with a bogus qualifier
  });

  it('rejects tokens containing slashes WITHOUT making any API call', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ login: 'x' }))) as unknown as typeof fetch;
    const result = await resolvePerson(clientWith(fetchImpl), TOKEN, 'nathan/secrets');
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects tokens containing whitespace WITHOUT API call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = clientWith(fetchImpl);
    expect(await resolvePerson(client, TOKEN, 'nathan smith')).toBeNull();
    expect(await resolvePerson(client, TOKEN, 'nathan\torg:victim')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects tokens with GitHub search qualifier syntax (colon)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = clientWith(fetchImpl);
    expect(await resolvePerson(client, TOKEN, 'nathan:admin')).toBeNull();
    expect(await resolvePerson(client, TOKEN, 'org:victim')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects empty and overlong tokens', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = clientWith(fetchImpl);
    expect(await resolvePerson(client, TOKEN, '')).toBeNull();
    expect(await resolvePerson(client, TOKEN, 'a'.repeat(40))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts exactly 39-char login at the boundary', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ login: 'a'.repeat(39) }))) as unknown as typeof fetch;
    const result = await resolvePerson(clientWith(fetchImpl), TOKEN, 'a'.repeat(39));
    expect(result).toEqual({ login: 'a'.repeat(39), resolved: 'literal' });
  });

  it('propagates non-404 errors during literal lookup (rate-limit)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } })),
    ) as unknown as typeof fetch;
    await expect(resolvePerson(clientWith(fetchImpl), TOKEN, 'Nath5')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('propagates non-404 errors during literal lookup (500 server error)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))) as unknown as typeof fetch;
    await expect(resolvePerson(clientWith(fetchImpl), TOKEN, 'Nath5')).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('propagates rate-limit during search fallback', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    }) as unknown as typeof fetch;
    await expect(
      resolvePerson(clientWith(fetchImpl), TOKEN, 'nathan', { orgs: ['acme'] }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});
