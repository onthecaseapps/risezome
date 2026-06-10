import { describe, expect, it, vi } from 'vitest';
import { GithubClient } from '../../../src/skills/github/client.js';
import { ConnectorAuthError, RateLimitedError } from '../../../src/skills/github/connector-errors.js';
import type { AuthResult } from '../../../src/skills/github/connector-errors.js';

const AUTH: AuthResult = { kind: 'oauth2', accessToken: 'inst_tok' };

function client(fetchImpl: typeof fetch): GithubClient {
  return new GithubClient({ fetchImpl });
}

describe('GithubClient — 403 classification', () => {
  it('403 with x-ratelimit-remaining=0 → RateLimitedError (primary limit)', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
        }),
      );
    await expect(client(fetchImpl).get(AUTH, '/x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('403 with retry-after and NON-zero remaining → RateLimitedError (secondary limit), not auth', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('You have exceeded a secondary rate limit.', {
          status: 403,
          headers: { 'retry-after': '30', 'x-ratelimit-remaining': '4999' },
        }),
      );
    const err = await client(fetchImpl)
      .get(AUTH, '/x')
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(30_000);
  });

  it('403 with "secondary rate limit" in the body (no retry-after) → RateLimitedError', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('You have exceeded a secondary rate limit. Please wait.', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '4999' },
        }),
      );
    await expect(client(fetchImpl).get(AUTH, '/x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('plain 403 (no rate-limit markers) → ConnectorAuthError', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response('Forbidden', { status: 403, headers: { 'x-ratelimit-remaining': '4999' } }),
      );
    await expect(client(fetchImpl).get(AUTH, '/x')).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('401 → ConnectorAuthError', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('Bad credentials', { status: 401 }));
    await expect(client(fetchImpl).get(AUTH, '/x')).rejects.toMatchObject({ status: 401 });
  });
});

describe('GithubClient — abort signal', () => {
  it('threads the signal into fetch', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await client(fetchImpl).getJson(AUTH, '/x', undefined, controller.signal);
    expect(seen).toEqual([controller.signal]);
  });
});
