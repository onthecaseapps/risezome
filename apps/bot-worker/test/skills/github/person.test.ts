import { describe, expect, it, vi } from 'vitest';
import { resolvePerson } from '../../../src/skills/github/person.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import { GithubClient } from '../../../src/skills/github/client.js';
import { ConnectorAuthError, RateLimitedError, type AuthResult } from '../../../src/skills/github/connector-errors.js';

const AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };

function ctxWith(fetchImpl: typeof fetch): LiveSkillContext {
  const client = new GithubClient({ fetchImpl });
  return { client, auth: AUTH, repo: { owner: 'o', name: 'r' } };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('resolvePerson', () => {
  it('literal lookup hit returns {login, resolved: literal}', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ login: 'Nath5' })));
    const result = await resolvePerson('Nath5', ctxWith(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ login: 'Nath5', resolved: 'literal' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('literal 404 then search hit returns {login, resolved: search}', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(jsonResponse({ items: [{ login: 'Nath5' }] }));
    });
    const result = await resolvePerson('nathan', ctxWith(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ login: 'Nath5', resolved: 'search' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('literal 404 + search empty returns null', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(jsonResponse({ items: [] }));
    });
    const result = await resolvePerson('ghost', ctxWith(fetchImpl as unknown as typeof fetch));
    expect(result).toBeNull();
  });

  it('rejects tokens containing slashes WITHOUT making any API call', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ login: 'x' })));
    const result = await resolvePerson('nathan/secrets', ctxWith(fetchImpl as unknown as typeof fetch));
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects tokens containing whitespace WITHOUT API call', async () => {
    const fetchImpl = vi.fn();
    expect(await resolvePerson('nathan smith', ctxWith(fetchImpl as unknown as typeof fetch))).toBeNull();
    expect(await resolvePerson('nathan\torg:victim', ctxWith(fetchImpl as unknown as typeof fetch))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects tokens with GitHub search qualifier syntax (colon)', async () => {
    const fetchImpl = vi.fn();
    expect(await resolvePerson('nathan:admin', ctxWith(fetchImpl as unknown as typeof fetch))).toBeNull();
    expect(await resolvePerson('org:victim', ctxWith(fetchImpl as unknown as typeof fetch))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects empty and overlong tokens', async () => {
    const fetchImpl = vi.fn();
    const ctx = ctxWith(fetchImpl as unknown as typeof fetch);
    expect(await resolvePerson('', ctx)).toBeNull();
    expect(await resolvePerson('a'.repeat(40), ctx)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts exactly 39-char login at the boundary', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ login: 'a'.repeat(39) })));
    const result = await resolvePerson('a'.repeat(39), ctxWith(fetchImpl as unknown as typeof fetch));
    expect(result).toEqual({ login: 'a'.repeat(39), resolved: 'literal' });
  });

  it('propagates non-404 errors during literal lookup (rate-limit)', async () => {
    // Return 429 to trigger RateLimitedError
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } })));
    await expect(resolvePerson('Nath5', ctxWith(fetchImpl as unknown as typeof fetch))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('propagates non-404 errors during literal lookup (500 server error)', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('boom', { status: 500 })));
    await expect(resolvePerson('Nath5', ctxWith(fetchImpl as unknown as typeof fetch))).rejects.toBeInstanceOf(
      ConnectorAuthError,
    );
  });

  it('propagates rate-limit during search fallback', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    });
    await expect(resolvePerson('nathan', ctxWith(fetchImpl as unknown as typeof fetch))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
