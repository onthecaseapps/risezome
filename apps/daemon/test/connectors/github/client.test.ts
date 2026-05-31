import { describe, expect, it } from 'vitest';
import { GithubClient } from '../../../src/connectors/github/client.js';
import {
  ConnectorAuthError,
  RateLimitedError,
  type AuthResult,
} from '../../../src/connectors/contract.js';

const TEST_AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_secret_token' };

describe('GithubClient', () => {
  it('sets Authorization, Accept, User-Agent, and API version headers', async () => {
    let captured: Headers | undefined;
    const client = new GithubClient({
      fetchImpl: (_input, init) => {
        captured = new Headers(init?.headers);
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await client.get(TEST_AUTH, '/user');
    expect(captured?.get('Authorization')).toBe(`Bearer ${TEST_AUTH.token}`);
    expect(captured?.get('Accept')).toBe('application/vnd.github+json');
    expect(captured?.get('User-Agent')).toBe('risezome-daemon');
    expect(captured?.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  it('appends query parameters to the URL', async () => {
    let capturedUrl: string | undefined;
    const client = new GithubClient({
      fetchImpl: (input) => {
        capturedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await client.get(TEST_AUTH, '/repos/x/y/issues', { state: 'all', sort: 'updated' });
    expect(capturedUrl).toContain('/repos/x/y/issues');
    expect(capturedUrl).toContain('state=all');
    expect(capturedUrl).toContain('sort=updated');
  });

  it('raises RateLimitedError when 403 with X-RateLimit-Remaining: 0', async () => {
    const client = new GithubClient({
      fetchImpl: async () =>
        new Response('rate limited', {
          status: 403,
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
          },
        }),
    });
    await expect(client.get(TEST_AUTH, '/x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('raises RateLimitedError on 429 with retry-after', async () => {
    const client = new GithubClient({
      fetchImpl: async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '5' },
        }),
    });
    await expect(client.get(TEST_AUTH, '/x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('raises ConnectorAuthError on 401 (not rate limited)', async () => {
    const client = new GithubClient({
      fetchImpl: async () =>
        new Response('Bad credentials', {
          status: 401,
          headers: { 'X-RateLimit-Remaining': '4999' },
        }),
    });
    await expect(client.get(TEST_AUTH, '/x')).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('populates ConnectorAuthError.status with the HTTP status on 401', async () => {
    const client = new GithubClient({
      fetchImpl: () =>
        Promise.resolve(new Response('{}', { status: 401, headers: { 'X-RateLimit-Remaining': '4999' } })),
    });
    try {
      await client.get(TEST_AUTH, '/x');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorAuthError);
      expect((err as ConnectorAuthError).status).toBe(401);
    }
  });

  it('populates ConnectorAuthError.status with the HTTP status on 403', async () => {
    const client = new GithubClient({
      fetchImpl: () =>
        Promise.resolve(new Response('{}', { status: 403, headers: { 'X-RateLimit-Remaining': '4999' } })),
    });
    try {
      await client.get(TEST_AUTH, '/x');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as ConnectorAuthError).status).toBe(403);
    }
  });

  it('populates ConnectorAuthError.status with 404 on a not-found response', async () => {
    const client = new GithubClient({
      fetchImpl: () => Promise.resolve(new Response('not found', { status: 404 })),
    });
    try {
      await client.get(TEST_AUTH, '/users/ghost');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorAuthError);
      expect((err as ConnectorAuthError).status).toBe(404);
    }
  });

  it('logs are redacted: a request log entry does not contain the PAT', async () => {
    const logs: { msg: string; meta?: Record<string, unknown> }[] = [];
    const client = new GithubClient({
      fetchImpl: async () => new Response('{}', { status: 200 }),
      logger: {
        log: (_lvl, msg, meta) => logs.push({ msg, ...(meta !== undefined && { meta }) }),
      },
    });
    await client.get(TEST_AUTH, '/user');
    const allLogText = JSON.stringify(logs);
    expect(allLogText).not.toContain('gh_pat_secret_token');
    expect(allLogText).toContain('[REDACTED]');
  });
});
