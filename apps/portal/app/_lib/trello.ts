/**
 * Trello integration helpers: auth-URL construction, token identity lookup,
 * and (below, added in U3) the read client for boards/cards/comments.
 *
 * Trello has no org/app install — auth is a per-user read token. We connect one
 * org-level token via the `/1/authorize` flow and store it in
 * `trello_connections`. The token is returned in the callback URL *fragment*
 * (not server-readable), so a small client page posts it back.
 */

const TRELLO_AUTHORIZE_URL = 'https://trello.com/1/authorize';
export const TRELLO_API_BASE = 'https://api.trello.com/1';

export function requireTrelloApiKey(): string {
  const key = process.env['TRELLO_API_KEY'];
  if (key === undefined || key.length === 0) {
    throw new Error('Missing required environment variable: TRELLO_API_KEY');
  }
  return key;
}

/**
 * Build the Trello authorization URL. `scope=read` + `expiration=never` yields
 * a long-lived read token; `response_type=token` + `callback_method=fragment`
 * makes Trello redirect to `returnUrl#token=…`. The CSRF `state` rides in the
 * returnUrl query so the callback can bind the token to the initiating org.
 */
export function buildTrelloAuthorizeUrl(args: {
  apiKey: string;
  returnUrl: string;
  state: string;
}): string {
  const returnUrlWithState = `${args.returnUrl}?state=${encodeURIComponent(args.state)}`;
  const params = new URLSearchParams({
    expiration: 'never',
    scope: 'read',
    response_type: 'token',
    callback_method: 'fragment',
    name: 'Risezome',
    key: args.apiKey,
    return_url: returnUrlWithState,
  });
  return `${TRELLO_AUTHORIZE_URL}?${params.toString()}`;
}

/** Raised when Trello rejects the token (revoked/invalid). Never retried. */
export class TrelloAuthError extends Error {
  constructor(message = 'Trello token is invalid or has been revoked') {
    super(message);
    this.name = 'TrelloAuthError';
  }
}

export interface TrelloMember {
  readonly id: string;
  readonly username: string | null;
}

/**
 * Resolve the member behind a token (also validates the token). A 401 means the
 * token is invalid/revoked → `TrelloAuthError`.
 */
export async function fetchTrelloMember(token: string, apiKey: string): Promise<TrelloMember> {
  const url = `${TRELLO_API_BASE}/members/me?${new URLSearchParams({
    key: apiKey,
    token,
    fields: 'id,username',
  }).toString()}`;
  const res = await fetch(url);
  if (res.status === 401) throw new TrelloAuthError();
  if (!res.ok) {
    throw new Error(`Trello /members/me failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { id: string; username?: string };
  return { id: body.id, username: body.username ?? null };
}
