import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServiceRoleClient } from '../../../../_lib/supabase-server';
import { buildAtlassianAuthorizeUrl, requireAtlassianClientId } from '../../../../_lib/atlassian';

/**
 * Kick off the Atlassian OAuth 2.0 (3LO) flow. Mint a single-use CSRF state
 * (reusing pending_installations, as Trello/GitHub do), bound to the user +
 * their active org, then 302 to auth.atlassian.com/authorize. Atlassian
 * redirects back to /api/atlassian/callback with `code` + `state` (server-side
 * auth-code flow — no client fragment).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user, orgId } = await requireAuthedUserWithOrg();

  // The Atlassian integration isn't configured on this deployment (no
  // ATLASSIAN_CLIENT_ID). Redirect back with a clear message, not a 500.
  let clientId: string;
  try {
    clientId = requireAtlassianClientId();
  } catch {
    return NextResponse.redirect(new URL('/sources?error=atlassian_not_configured', request.nextUrl.origin));
  }
  const stateToken = randomBytes(32).toString('hex');

  const service = createServiceRoleClient();
  const { error: insertErr } = await service.from('pending_installations').insert({
    state_token: stateToken,
    org_id: orgId,
    user_id: user.id,
  });
  if (insertErr !== null) {
    console.error('[sources.atlassian.connect] pending insert failed:', insertErr);
    return NextResponse.redirect(new URL('/sources?error=atlassian_init_failed', request.nextUrl.origin));
  }

  const redirectUri = new URL('/api/atlassian/callback', request.nextUrl.origin).toString();
  const authorizeUrl = buildAtlassianAuthorizeUrl({ clientId, redirectUri, state: stateToken });
  return NextResponse.redirect(authorizeUrl);
}
