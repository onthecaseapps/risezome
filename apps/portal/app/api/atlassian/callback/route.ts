import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '../../../_lib/supabase-server';
import {
  exchangeAtlassianCode,
  fetchAccessibleResources,
  requireAtlassianClientId,
  requireAtlassianClientSecret,
} from '../../../_lib/atlassian';
import { encryptToken } from '../../../_lib/token-crypto';

/**
 * Completes the Atlassian OAuth flow. Atlassian redirects here with
 * `?code&state` (or `?error` if the user denied consent). We:
 *   1. Verify `state` against an unexpired pending_installations row, delete it
 *      (anti-replay), and recover the initiating org.
 *   2. Exchange the code for access + refresh tokens (server-side).
 *   3. Resolve the cloudId via accessible-resources (first site for v1).
 *   4. Upsert the org's atlassian_connections row (service-role only).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError !== null) {
    return NextResponse.redirect(new URL('/sources?error=atlassian_denied', url.origin));
  }
  if (code === null || state === null) {
    return NextResponse.redirect(new URL('/sources?error=atlassian_missing_params', url.origin));
  }

  const service = createServiceRoleClient();

  const { data: pending, error: pendingErr } = await service
    .from('pending_installations')
    .select('org_id, expires_at')
    .eq('state_token', state)
    .maybeSingle();
  if (pendingErr !== null) {
    return NextResponse.redirect(
      new URL('/sources?error=atlassian_state_lookup_failed', url.origin),
    );
  }
  if (pending === null) {
    return NextResponse.redirect(new URL('/sources?error=atlassian_state_unknown', url.origin));
  }
  await service.from('pending_installations').delete().eq('state_token', state);
  if (new Date(pending.expires_at as string) < new Date()) {
    return NextResponse.redirect(new URL('/sources?error=atlassian_state_expired', url.origin));
  }
  const orgId = pending.org_id as string;

  const redirectUri = new URL('/api/atlassian/callback', url.origin).toString();
  let tokens;
  let resources;
  try {
    tokens = await exchangeAtlassianCode({
      code,
      redirectUri,
      clientId: requireAtlassianClientId(),
      clientSecret: requireAtlassianClientSecret(),
    });
    resources = await fetchAccessibleResources(tokens.accessToken);
  } catch (err) {
    console.error('[atlassian.callback] token exchange / resources failed:', err);
    return NextResponse.redirect(new URL('/sources?error=atlassian_exchange_failed', url.origin));
  }

  const site = resources[0];
  if (site === undefined) {
    return NextResponse.redirect(new URL('/sources?error=atlassian_no_sites', url.origin));
  }

  // Encrypt the token pair at rest (U2 / S2) before storing.
  const [accessTokenEnc, refreshTokenEnc] = await Promise.all([
    encryptToken(service, tokens.accessToken),
    encryptToken(service, tokens.refreshToken),
  ]);
  const { error: upsertErr } = await service.from('atlassian_connections').upsert(
    {
      org_id: orgId,
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      token_version: 0,
      expires_at: new Date(tokens.expiresAt).toISOString(),
      cloud_id: site.cloudId,
      site_url: site.url,
      scopes: tokens.scope,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' },
  );
  if (upsertErr !== null) {
    return NextResponse.redirect(new URL('/sources?error=atlassian_store_failed', url.origin));
  }

  return NextResponse.redirect(new URL('/sources?notice=atlassian_connected', url.origin));
}
