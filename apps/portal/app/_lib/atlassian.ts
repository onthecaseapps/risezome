/**
 * Atlassian OAuth 2.0 (3LO) helpers: authorize-URL construction, code/refresh
 * token exchange, and the accessible-resources (cloudId) lookup.
 *
 * Atlassian uses a standard server-side auth-code flow (unlike Trello's
 * token-in-fragment), and its refresh tokens ROTATE on each refresh with a
 * 90-day idle expiry — the token manager (atlassian-token.ts) handles rotation.
 */

const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
export const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
export const ATLASSIAN_ACCESSIBLE_RESOURCES_URL =
  'https://api.atlassian.com/oauth/token/accessible-resources';
export const ATLASSIAN_API_BASE = 'https://api.atlassian.com';

/**
 * GRANULAR read scopes covering Jira projects/issues/comments + Confluence
 * spaces/pages, plus offline_access for the refresh token.
 *
 * These MUST be granular, not classic: the client calls the Confluence REST API
 * v2 (`/wiki/api/v2/spaces`, `/wiki/api/v2/pages`), and v2 endpoints reject
 * classic scopes (`read:confluence-content.all`) with 401/403 "scope does not
 * match" (Atlassian CONFCLOUD-75668, closed "Not a Bug"). Classic and granular
 * scopes also cannot be mixed in one 3LO token, so Jira is granular here too.
 * The Developer Console app must enable the matching granular scopes under
 * Permissions → Jira API / Confluence API.
 */
export const ATLASSIAN_SCOPES = [
  // Jira v3 — project search, JQL issue search, comments, assignee/user names
  'read:project:jira',
  'read:issue:jira',
  'read:jql:jira',
  'read:comment:jira',
  'read:user:jira',
  // Confluence v2 — list spaces, list pages + storage body
  'read:space:confluence',
  'read:page:confluence',
  // refresh token
  'offline_access',
].join(' ');

export function requireAtlassianClientId(): string {
  const v = process.env['ATLASSIAN_CLIENT_ID'];
  if (v === undefined || v.length === 0) throw new Error('Missing env: ATLASSIAN_CLIENT_ID');
  return v;
}

export function requireAtlassianClientSecret(): string {
  const v = process.env['ATLASSIAN_CLIENT_SECRET'];
  if (v === undefined || v.length === 0) throw new Error('Missing env: ATLASSIAN_CLIENT_SECRET');
  return v;
}

/** Raised when Atlassian rejects a token / refresh (revoked, idle-expired). */
export class AtlassianAuthError extends Error {
  constructor(message = 'Atlassian access was revoked or expired; reconnect required') {
    super(message);
    this.name = 'AtlassianAuthError';
  }
}

/**
 * Build the Atlassian authorize URL. `audience=api.atlassian.com` is REQUIRED
 * (omitting it yields a token unusable with the REST API); `offline_access` in
 * scope gates the refresh token; `prompt=consent` forces the consent screen.
 */
export function buildAtlassianAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: args.clientId,
    scope: ATLASSIAN_SCOPES,
    redirect_uri: args.redirectUri,
    state: args.state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `${ATLASSIAN_AUTHORIZE_URL}?${params.toString()}`;
}

export interface AtlassianTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Absolute expiry (ms epoch) computed from expires_in. */
  readonly expiresAt: number;
  readonly scope: string;
}

interface RawTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

function toTokenSet(raw: RawTokenResponse, now: number): AtlassianTokenSet {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: now + raw.expires_in * 1000,
    scope: raw.scope,
  };
}

/** Exchange an authorization code for the initial token set. */
export async function exchangeAtlassianCode(args: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  now?: number;
}): Promise<AtlassianTokenSet> {
  const res = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Atlassian token exchange failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawTokenResponse;
  return toTokenSet(raw, args.now ?? Date.now());
}

/**
 * Exchange a refresh token for a new token set. Refresh tokens rotate: the
 * response carries a NEW refresh token and the old one is invalidated. An
 * invalid/expired refresh token returns an `invalid_grant` error → AtlassianAuthError.
 */
export async function refreshAtlassianToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  now?: number;
}): Promise<AtlassianTokenSet> {
  const res = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
    }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    if (body.includes('invalid_grant') || res.status === 401 || res.status === 403) {
      throw new AtlassianAuthError();
    }
    throw new Error(`Atlassian refresh failed: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`Atlassian refresh failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawTokenResponse;
  return toTokenSet(raw, args.now ?? Date.now());
}

export interface AtlassianResource {
  readonly cloudId: string;
  readonly name: string;
  readonly url: string;
}

/** Resolve the Atlassian sites (cloudId) a token can access. */
export async function fetchAccessibleResources(accessToken: string): Promise<AtlassianResource[]> {
  const res = await fetch(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (res.status === 401) throw new AtlassianAuthError();
  if (!res.ok) {
    throw new Error(`Atlassian accessible-resources failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as Array<{ id: string; name: string; url: string }>;
  return raw.map((r) => ({ cloudId: r.id, name: r.name, url: r.url }));
}
