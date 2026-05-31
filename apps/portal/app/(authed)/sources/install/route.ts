import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { getInstallUrl } from '../../../_lib/github-app';
import { createServiceRoleClient } from '../../../_lib/supabase-server';

/**
 * Kick off the GitHub App install flow. Authed members hit this when they
 * click "Connect GitHub" on /sources. We mint a single-use CSRF state token,
 * persist it (bound to the user + their currently-active org) for 15 minutes,
 * then 302 the user over to GitHub's installation page with the state echoed
 * in the URL. GitHub redirects back to /api/github/install-callback with the
 * same state — we look it up there to know which org owns the installation.
 *
 * Why a server-side state table rather than a signed cookie:
 *   - The callback runs against the same Supabase row regardless of which
 *     browser/device finishes the flow (a user could start in one tab + finish
 *     in another), so the lookup must be server-side
 *   - Pending rows expire automatically (15 min) and are deleted on use, so
 *     replay is bounded even if an attacker observed the state in transit
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const { user, orgId } = await requireAuthedUserWithOrg();

  const stateToken = randomBytes(32).toString('hex');

  const service = createServiceRoleClient();
  const { error: insertErr } = await service.from('pending_installations').insert({
    state_token: stateToken,
    org_id: orgId,
    user_id: user.id,
    // expires_at defaults to now() + 15 min in the migration.
  });
  if (insertErr !== null) {
    // eslint-disable-next-line no-console
    console.error('[sources.install] pending_installations insert failed:', insertErr);
    return NextResponse.redirect(new URL('/sources?error=install_init_failed', _request.url));
  }

  return NextResponse.redirect(getInstallUrl(stateToken));
}
