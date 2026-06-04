import type { SupabaseClient } from '@supabase/supabase-js';
import {
  refreshAtlassianToken,
  requireAtlassianClientId,
  requireAtlassianClientSecret,
} from './atlassian';
import {
  decryptForOrgFromBytea,
  encryptForOrgToBytea,
  EnvelopeCryptoError,
} from '@risezome/crypto';

/**
 * A crypto (KMS/keyring) failure while (de/en)crypting the stored Atlassian
 * tokens. Deliberately DISTINCT from `AtlassianAuthError`: a KMS blip or a brief
 * deploy-window inconsistency is TRANSIENT/retryable, not a dead refresh token,
 * so it must NOT surface to the user as "reconnect your Atlassian account".
 * Callers (the Jira/Confluence indexers) treat it as a normal throw → Inngest
 * retries the step rather than marking the source errored.
 */
export class AtlassianTokenCryptoError extends Error {
  override readonly name = 'AtlassianTokenCryptoError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
  }
}

/**
 * Atlassian access-token manager. Returns a valid access token for an org's
 * connection, refreshing when expired. Atlassian refresh tokens ROTATE — each
 * refresh returns a new refresh token and invalidates the old — so the new pair
 * is persisted atomically.
 *
 * Two layers of refresh serialization (KTD3):
 *  - In-process: concurrent callers (e.g. the Jira and Confluence indexers in
 *    the same worker) share a single in-flight refresh per connection.
 *  - Cross-process: the persist is a GUARDED update (only writes if the stored
 *    refresh token still matches the one we refreshed from); a loser re-reads
 *    the winner's tokens. Atlassian's 10-minute reuse window tolerates the brief
 *    overlap when two workers refresh near-simultaneously.
 */

const EXPIRY_SKEW_MS = 60_000; // refresh a minute early to avoid mid-call expiry

export interface ValidToken {
  readonly accessToken: string;
  readonly cloudId: string;
  readonly siteUrl: string | null;
}

interface ConnectionRow {
  id: string;
  /** Decrypted in readConnection (stored as access_token_enc bytea). */
  access_token: string;
  /** Decrypted in readConnection (stored as refresh_token_enc bytea). */
  refresh_token: string;
  expires_at: string;
  cloud_id: string;
  site_url: string | null;
  /** Optimistic-concurrency guard for rotation (U2: replaces token-byte compare). */
  token_version: number;
}

interface ConnectionEncRow {
  id: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string;
  cloud_id: string;
  site_url: string | null;
  token_version: number;
}

const inflightRefresh = new Map<string, Promise<ValidToken>>();

async function readConnection(
  orgId: string,
  service: SupabaseClient,
): Promise<ConnectionRow | null> {
  const { data, error } = await service
    .from('atlassian_connections')
    .select(
      'id, access_token_enc, refresh_token_enc, expires_at, cloud_id, site_url, token_version',
    )
    .eq('org_id', orgId)
    .maybeSingle();
  if (error !== null) throw new Error(`atlassian_connections read failed: ${error.message}`);
  const row = data as ConnectionEncRow | null;
  if (row === null) return null;
  // A pre-encryption row (or a wiped one) has no ciphertext → treat as "reconnect".
  if (row.access_token_enc === null || row.refresh_token_enc === null) return null;
  // U10: tokens decrypted app-side under the org's per-org KMS key. The bytea
  // columns come back as `\x<hex>` strings → decode → decrypt. A crypto failure
  // here (KMS down, deploy-window inconsistency) is mapped to a DISTINCT
  // retryable error so it is not misread as a dead connection ("reconnect").
  let accessToken: string;
  let refreshToken: string;
  try {
    [accessToken, refreshToken] = await Promise.all([
      decryptForOrgFromBytea(orgId, row.access_token_enc),
      decryptForOrgFromBytea(orgId, row.refresh_token_enc),
    ]);
  } catch (err) {
    if (err instanceof EnvelopeCryptoError) {
      throw new AtlassianTokenCryptoError(
        `decrypt of Atlassian tokens failed for org ${orgId} (transient KMS/keyring error)`,
        { cause: err },
      );
    }
    throw err;
  }
  return {
    id: row.id,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: row.expires_at,
    cloud_id: row.cloud_id,
    site_url: row.site_url,
    token_version: row.token_version,
  };
}

function isExpired(expiresAt: string, now: number): boolean {
  return Date.parse(expiresAt) - EXPIRY_SKEW_MS <= now;
}

/**
 * Get a valid access token (+ cloudId) for the org's Atlassian connection,
 * refreshing if needed. Throws `AtlassianAuthError` (from refreshAtlassianToken)
 * if the refresh token is dead — the caller marks sources errored + prompts
 * re-connect.
 */
export async function getValidAtlassianToken(
  orgId: string,
  service: SupabaseClient,
  now: number = Date.now(),
): Promise<ValidToken> {
  const conn = await readConnection(orgId, service);
  if (conn === null) throw new Error(`no Atlassian connection for org ${orgId}`);

  if (!isExpired(conn.expires_at, now)) {
    return { accessToken: conn.access_token, cloudId: conn.cloud_id, siteUrl: conn.site_url };
  }

  // Coalesce concurrent in-process refreshes for this connection.
  let inflight = inflightRefresh.get(conn.id);
  if (inflight === undefined) {
    inflight = doRefresh(orgId, conn, service, now).finally(() => inflightRefresh.delete(conn.id));
    inflightRefresh.set(conn.id, inflight);
  }
  return inflight;
}

async function doRefresh(
  orgId: string,
  conn: ConnectionRow,
  service: SupabaseClient,
  now: number,
): Promise<ValidToken> {
  const set = await refreshAtlassianToken({
    refreshToken: conn.refresh_token,
    clientId: requireAtlassianClientId(),
    clientSecret: requireAtlassianClientSecret(),
    now,
  });

  // Guarded update: only persist if token_version still matches what we read
  // (U2 — ciphertext is non-deterministic so we can't compare token bytes). If
  // another worker already rotated it, our update affects 0 rows and we adopt
  // their fresher tokens instead. Encrypt the new pair under the org's per-org
  // KMS key (U9) before writing, serialized to the bytea hex-text literal.
  //
  // NOTE: atlassian_connections.token_version is the OPTIMISTIC-CONCURRENCY guard
  // (a monotonic counter), not the crypto-format sentinel — it must keep
  // incrementing per rotation. The U11 migration therefore identifies un-migrated
  // atlassian rows by ESDK-decrypt probing rather than by token_version.
  let accessEnc: string;
  let refreshEnc: string;
  try {
    [accessEnc, refreshEnc] = await Promise.all([
      encryptForOrgToBytea(orgId, set.accessToken),
      encryptForOrgToBytea(orgId, set.refreshToken),
    ]);
  } catch (err) {
    if (err instanceof EnvelopeCryptoError) {
      throw new AtlassianTokenCryptoError(
        `encrypt of refreshed Atlassian tokens failed for org ${orgId} (transient KMS/keyring error)`,
        { cause: err },
      );
    }
    throw err;
  }
  const { data } = await service
    .from('atlassian_connections')
    .update({
      access_token_enc: accessEnc,
      refresh_token_enc: refreshEnc,
      expires_at: new Date(set.expiresAt).toISOString(),
      token_version: conn.token_version + 1,
    })
    .eq('id', conn.id)
    .eq('token_version', conn.token_version)
    .select('id');

  if (Array.isArray(data) && data.length > 0) {
    return { accessToken: set.accessToken, cloudId: conn.cloud_id, siteUrl: conn.site_url };
  }

  // Lost the guard race — read whatever the winner persisted.
  const fresh = await readConnection(orgId, service);
  if (fresh === null) throw new Error(`Atlassian connection vanished for org ${orgId}`);
  return { accessToken: fresh.access_token, cloudId: fresh.cloud_id, siteUrl: fresh.site_url };
}
