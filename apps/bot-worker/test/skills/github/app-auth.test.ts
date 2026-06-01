import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { GithubAppAuth, buildGithubAppAuth } from '../../../src/skills/github/app-auth.js';

function makeKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

describe('GithubAppAuth.installationToken', () => {
  it('exchanges an App JWT for an installation token and returns it', async () => {
    let seenAuth = '';
    let seenUrl = '';
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      seenUrl = typeof input === 'string' ? input : input.toString();
      seenAuth = String((init?.headers as Record<string, string>).Authorization ?? '');
      return Promise.resolve(
        new Response(JSON.stringify({ token: 'ghs_installtoken', expires_at: '2999-01-01T00:00:00Z' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const auth = new GithubAppAuth({ appId: '123', privateKeyPem: makeKeyPem(), fetchImpl, now: () => 0 });
    const token = await auth.installationToken(42);
    expect(token).toBe('ghs_installtoken');
    expect(seenUrl).toBe('https://api.github.com/app/installations/42/access_tokens');
    // Authorization carries a JWT (header.payload.signature).
    expect(seenAuth.startsWith('Bearer ')).toBe(true);
    expect(seenAuth.split('.')).toHaveLength(3);
  });

  it('caches the token and does not re-exchange within the expiry margin', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2999-01-01T00:00:00Z' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch;
    const auth = new GithubAppAuth({ appId: '123', privateKeyPem: makeKeyPem(), fetchImpl, now: () => 0 });
    await auth.installationToken(1);
    await auth.installationToken(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('re-exchanges for a different installation', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2999-01-01T00:00:00Z' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as unknown as typeof fetch;
    const auth = new GithubAppAuth({ appId: '123', privateKeyPem: makeKeyPem(), fetchImpl, now: () => 0 });
    await auth.installationToken(1);
    await auth.installationToken(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-ok token exchange', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('nope', { status: 403 }))) as unknown as typeof fetch;
    const auth = new GithubAppAuth({ appId: '123', privateKeyPem: makeKeyPem(), fetchImpl, now: () => 0 });
    await expect(auth.installationToken(1)).rejects.toThrow(/token exchange failed/);
  });
});

describe('buildGithubAppAuth', () => {
  it('returns null when GITHUB_APP_ID is missing', () => {
    expect(buildGithubAppAuth({ GITHUB_APP_PRIVATE_KEY_BASE64: 'x' })).toBeNull();
  });

  it('returns null when GITHUB_APP_PRIVATE_KEY_BASE64 is missing', () => {
    expect(buildGithubAppAuth({ GITHUB_APP_ID: '123' })).toBeNull();
  });

  it('decodes the base64 PEM and builds an instance when both are present', () => {
    const pem = makeKeyPem();
    const env = {
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(pem, 'utf8').toString('base64'),
    } as NodeJS.ProcessEnv;
    expect(buildGithubAppAuth(env)).toBeInstanceOf(GithubAppAuth);
  });
});
