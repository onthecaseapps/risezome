// @vitest-environment node
// Runs in node (not jsdom): the AWS Encryption SDK must load as a single real
// Node module instance; under jsdom/Vite-SSR it duplicates and throws
// "Unsupported dataKey type".
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptForOrgToBytea, decryptForOrgFromBytea } from '@risezome/crypto';
import { getValidAtlassianToken } from '../../app/_lib/atlassian-token';
import { AtlassianAuthError } from '../../app/_lib/atlassian';

const ORG = 'org-atl-test';

beforeAll(() => {
  process.env['ATLASSIAN_CLIENT_ID'] = 'cid';
  process.env['ATLASSIAN_CLIENT_SECRET'] = 'csec';
  // Use the real @risezome/crypto module with its local RawAES fallback so the
  // decrypt path runs end-to-end (no AWS); mirrors how prod encrypts/decrypts.
  process.env['RISEZOME_DEV_CRYPTO_KEY'] = 'atlassian-token-test-secret';
});
afterEach(() => vi.restoreAllMocks());

/** The encrypted connection row as it lives in atlassian_connections. */
interface EncConn {
  id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  cloud_id: string;
  site_url: string | null;
  token_version: number;
}

/**
 * Stateful Supabase stub: read + guarded update of one encrypted connection row.
 * The guard is now token_version (replacing the old refresh-token-byte compare):
 * the update only lands when the read token_version still matches.
 */
function makeService(initial: EncConn): { service: SupabaseClient; current: () => EncConn } {
  let row = { ...initial };
  const service = {
    from() {
      return {
        select() {
          return { eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) };
        },
        update(patch: Partial<EncConn>) {
          return {
            eq() {
              return {
                eq(_col: string, oldVersion: number) {
                  return {
                    select: async () => {
                      if (oldVersion === row.token_version) {
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

async function seedConn(overrides: Partial<{ access: string; refresh: string; expires: string; siteUrl: string | null }>): Promise<EncConn> {
  const access = overrides.access ?? 'AT';
  const refresh = overrides.refresh ?? 'RT';
  return {
    id: 'c1',
    access_token_enc: await encryptForOrgToBytea(ORG, access),
    refresh_token_enc: await encryptForOrgToBytea(ORG, refresh),
    expires_at: overrides.expires ?? future(),
    cloud_id: 'cloud',
    site_url: overrides.siteUrl ?? null,
    token_version: 0,
  };
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
    const { service } = makeService(await seedConn({ access: 'AT', expires: future(), siteUrl: 'u' }));
    const tok = await getValidAtlassianToken(ORG, service);
    expect(tok).toEqual({ accessToken: 'AT', cloudId: 'cloud', siteUrl: 'u' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes when expired and atomically persists the rotated tokens (encrypted)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(refreshResponse('AT2', 'RT2'));
    const { service, current } = makeService(await seedConn({ access: 'AT', refresh: 'RT', expires: past() }));
    const tok = await getValidAtlassianToken(ORG, service);
    expect(tok.accessToken).toBe('AT2');
    // The persisted columns are ciphertext; decrypt to assert the rotated pair.
    expect(await decryptForOrgFromBytea(ORG, current().refresh_token_enc)).toBe('RT2');
    expect(await decryptForOrgFromBytea(ORG, current().access_token_enc)).toBe('AT2');
    expect(current().token_version).toBe(1); // guard bumped
  });

  it('coalesces concurrent refreshes into a single token request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refreshResponse('AT2', 'RT2'));
    const { service } = makeService(await seedConn({ expires: past() }));
    const [a, b] = await Promise.all([
      getValidAtlassianToken(ORG, service),
      getValidAtlassianToken(ORG, service),
    ]);
    expect(a.accessToken).toBe('AT2');
    expect(b.accessToken).toBe('AT2');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // single refresh
  });

  it('propagates AtlassianAuthError when the refresh token is dead', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    const { service } = makeService(await seedConn({ expires: past() }));
    await expect(getValidAtlassianToken(ORG, service)).rejects.toBeInstanceOf(AtlassianAuthError);
  });
});
