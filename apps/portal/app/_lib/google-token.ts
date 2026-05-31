import { createServiceRoleClient } from './supabase-server';

/**
 * Refresh Google access tokens using the user's stored refresh token.
 *
 * Storage (from U2):
 *   user_google_tokens
 *     - access_token (plaintext, ~1h lifetime)
 *     - refresh_token_enc (pgcrypto-encrypted with USER_TOKEN_ENCRYPTION_KEY)
 *     - expires_at
 *
 * Refresh strategy:
 *   - If `expires_at` is more than 60s away, return the cached access token.
 *   - Otherwise call Google's token endpoint with the decrypted refresh
 *     token, persist the new access token + expiry, and return it.
 *
 * Failure shape:
 *   - GoogleTokenMissingError       — no row, or refresh_token blank.
 *     The user must re-authenticate; caller surfaces "reconnect Google".
 *   - GoogleTokenRefreshError       — Google rejected the refresh
 *     (revoked grant, invalid_grant, etc). Caller usually deletes the row
 *     and prompts re-auth.
 *   - GoogleTokenTransientError     — 5xx / network. Caller can retry.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SKEW_SECONDS = 60;

export class GoogleTokenMissingError extends Error {
  constructor(message = 'No stored Google refresh token for this user') {
    super(message);
    this.name = 'GoogleTokenMissingError';
  }
}

export class GoogleTokenRefreshError extends Error {
  constructor(
    message: string,
    readonly providerCode: string | undefined,
  ) {
    super(message);
    this.name = 'GoogleTokenRefreshError';
  }
}

export class GoogleTokenTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTokenTransientError';
  }
}

export async function getGoogleAccessToken(userId: string): Promise<string> {
  const service = createServiceRoleClient();

  const { data: row, error } = await service
    .from('user_google_tokens')
    .select('access_token, refresh_token_enc, expires_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) {
    throw new GoogleTokenTransientError(`token row read failed: ${error.message}`);
  }
  if (row === null) {
    throw new GoogleTokenMissingError();
  }

  // If the cached access token is still good, return it. We pad with
  // SKEW_SECONDS to avoid handing out a token that's about to expire
  // mid-request — Google's token-expiry check is timezone-clean but
  // network round-trips eat real seconds.
  const expiresAt = new Date(row.expires_at as string).getTime();
  if (expiresAt - SKEW_SECONDS * 1000 > Date.now()) {
    return row.access_token as string;
  }

  // Decrypt the refresh token. We call the pgcrypto helper from U2
  // via .rpc() so the symmetric key never has to be applied in JS.
  const encryptionKey = requireEnv('USER_TOKEN_ENCRYPTION_KEY');
  const { data: refreshToken, error: decErr } = await service.rpc('decrypt_refresh_token', {
    ciphertext: row.refresh_token_enc as unknown as string,
    key: encryptionKey,
  });
  if (decErr !== null || refreshToken === null || refreshToken === undefined) {
    throw new GoogleTokenRefreshError(
      `decrypt_refresh_token failed: ${decErr?.message ?? 'returned null'}`,
      undefined,
    );
  }

  const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken as string,
  });

  let resp: Response;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new GoogleTokenTransientError(
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (resp.status >= 500) {
    throw new GoogleTokenTransientError(`google ${resp.status}`);
  }
  if (!resp.ok) {
    let providerCode: string | undefined;
    let providerMsg = '';
    try {
      const j = (await resp.json()) as { error?: string; error_description?: string };
      providerCode = j.error;
      providerMsg = j.error_description ?? '';
    } catch {
      // ignore body-parse failures; we still throw with status info
    }
    throw new GoogleTokenRefreshError(
      `google ${resp.status} ${providerCode ?? ''}${providerMsg.length > 0 ? ': ' + providerMsg : ''}`.trim(),
      providerCode,
    );
  }

  const json = (await resp.json()) as { access_token: string; expires_in: number; scope?: string };
  const newAccessToken = json.access_token;
  const newExpiresAt = new Date(Date.now() + (json.expires_in - SKEW_SECONDS) * 1000).toISOString();

  const updates: { access_token: string; expires_at: string; updated_at: string; scope?: string } = {
    access_token: newAccessToken,
    expires_at: newExpiresAt,
    updated_at: new Date().toISOString(),
  };
  if (json.scope !== undefined && json.scope.length > 0) updates.scope = json.scope;

  const { error: updateErr } = await service
    .from('user_google_tokens')
    .update(updates)
    .eq('user_id', userId);
  if (updateErr !== null) {
    // The token IS valid; we just couldn't cache it. Return it and let
    // the next request refresh again. Soft-fail rather than blocking the
    // call.
    // eslint-disable-next-line no-console
    console.warn('[google-token] cache update failed:', updateErr);
  }

  return newAccessToken;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
