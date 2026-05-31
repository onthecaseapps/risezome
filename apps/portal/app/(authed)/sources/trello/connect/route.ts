import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServiceRoleClient } from '../../../../_lib/supabase-server';
import { buildTrelloAuthorizeUrl, requireTrelloApiKey } from '../../../../_lib/trello';

/**
 * Kick off the Trello connect flow. Authed members hit this from "Connect
 * Trello" on /sources. We mint a single-use CSRF state token (reusing the
 * `pending_installations` table the GitHub flow uses), bind it to the user +
 * their active org for 15 minutes, then 302 to Trello's /1/authorize page with
 * `scope=read`. Trello redirects back to /sources/trello/callback with the
 * token in the URL fragment and our state echoed in the query.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user, orgId } = await requireAuthedUserWithOrg();

  const apiKey = requireTrelloApiKey();
  const stateToken = randomBytes(32).toString('hex');

  const service = createServiceRoleClient();
  const { error: insertErr } = await service.from('pending_installations').insert({
    state_token: stateToken,
    org_id: orgId,
    user_id: user.id,
  });
  if (insertErr !== null) {
    console.error('[sources.trello.connect] pending insert failed:', insertErr);
    return NextResponse.redirect(new URL('/sources?error=trello_init_failed', request.nextUrl.origin));
  }

  const returnUrl = new URL('/sources/trello/callback', request.nextUrl.origin).toString();
  const authorizeUrl = buildTrelloAuthorizeUrl({ apiKey, returnUrl, state: stateToken });
  return NextResponse.redirect(authorizeUrl);
}
