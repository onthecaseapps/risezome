import type { SupabaseClient } from '@supabase/supabase-js';
import {
  refreshAtlassianToken,
  requireAtlassianClientId,
  requireAtlassianClientSecret,
} from './atlassian';

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
  access_token: string;
  refresh_token: string;
  expires_at: string;
  cloud_id: string;
  site_url: string | null;
}

const inflightRefresh = new Map<string, Promise<ValidToken>>();

async function readConnection(orgId: string, service: SupabaseClient): Promise<ConnectionRow | null> {
  const { data, error } = await service
    .from('atlassian_connections')
    .select('id, access_token, refresh_token, expires_at, cloud_id, site_url')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error !== null) throw new Error(`atlassian_connections read failed: ${error.message}`);
  return (data as ConnectionRow | null) ?? null;
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

  // Guarded update: only persist if the stored refresh token still matches the
  // one we refreshed from. If another worker already rotated it, our update
  // affects 0 rows and we adopt their fresher tokens instead.
  const { data } = await service
    .from('atlassian_connections')
    .update({
      access_token: set.accessToken,
      refresh_token: set.refreshToken,
      expires_at: new Date(set.expiresAt).toISOString(),
    })
    .eq('id', conn.id)
    .eq('refresh_token', conn.refresh_token)
    .select('id');

  if (Array.isArray(data) && data.length > 0) {
    return { accessToken: set.accessToken, cloudId: conn.cloud_id, siteUrl: conn.site_url };
  }

  // Lost the guard race — read whatever the winner persisted.
  const fresh = await readConnection(orgId, service);
  if (fresh === null) throw new Error(`Atlassian connection vanished for org ${orgId}`);
  return { accessToken: fresh.access_token, cloudId: fresh.cloud_id, siteUrl: fresh.site_url };
}
