import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '../../../_lib/supabase-server';
import { fetchTrelloMember, requireTrelloApiKey, TrelloAuthError } from '../../../_lib/trello';
import { CRYPTO_VERSION, encryptForOrgToBytea, EnvelopeCryptoError } from '@risezome/crypto';

/**
 * Finish the Trello connect flow. The client callback page POSTs `{ token,
 * state }` here (the token came back in the URL fragment). We:
 *   1. Verify `state` against an unexpired `pending_installations` row (same
 *      CSRF table the GitHub flow uses) and delete it (anti-replay).
 *   2. Validate the token by resolving the member (`/members/me`); a 401 means
 *      the token is invalid/revoked → surface a re-connect error, store nothing.
 *   3. Upsert the org's `trello_connections` row (one per org).
 *
 * Service-role only: the token is a secret and `trello_connections` has no
 * member-readable RLS policy.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let token: unknown;
  let state: unknown;
  try {
    const body = (await request.json()) as { token?: unknown; state?: unknown };
    token = body.token;
    state = body.state;
  } catch {
    return NextResponse.json({ error: 'trello_bad_request' }, { status: 400 });
  }
  if (typeof token !== 'string' || token.length === 0 || typeof state !== 'string') {
    return NextResponse.json({ error: 'trello_bad_request' }, { status: 400 });
  }

  const service = createServiceRoleClient();

  // service-role-cross-org: OAuth callback has no org in scope yet; the unguessable
  // single-use state_token IS the cross-org-safe key that resolves org_id.
  const { data: pending, error: pendingErr } = await service
    .from('pending_installations')
    .select('org_id, expires_at')
    .eq('state_token', state)
    .maybeSingle();
  if (pendingErr !== null) {
    return NextResponse.json({ error: 'trello_state_lookup_failed' }, { status: 500 });
  }
  if (pending === null) {
    return NextResponse.json({ error: 'trello_state_unknown' }, { status: 400 });
  }
  // service-role-cross-org: delete keyed by the same unguessable state_token.
  await service.from('pending_installations').delete().eq('state_token', state);
  if (new Date(pending.expires_at as string) < new Date()) {
    return NextResponse.json({ error: 'trello_state_expired' }, { status: 400 });
  }
  const orgId = pending.org_id as string;

  // Validate the token + capture identity. 401 → revoked/invalid; store nothing.
  let member;
  try {
    member = await fetchTrelloMember(token, requireTrelloApiKey());
  } catch (err) {
    if (err instanceof TrelloAuthError) {
      return NextResponse.json({ error: 'trello_token_invalid' }, { status: 400 });
    }
    return NextResponse.json({ error: 'trello_member_lookup_failed' }, { status: 502 });
  }

  // U9: encrypt under the org's per-org KMS key (app-side ESDK), stored as a bytea
  // hex-text literal. token_version=2 marks the KMS-ESDK format (1 = legacy
  // pgcrypto) so the U11 migration can find un-migrated rows.
  let tokenEnc: string;
  try {
    tokenEnc = await encryptForOrgToBytea(orgId, token);
  } catch (err) {
    if (err instanceof EnvelopeCryptoError) {
      // KMS blip during connect: surface a typed 502 (Bad Gateway / upstream
      // crypto failure) rather than a 500 so the client can retry.
      console.error('[trello.connect] token encrypt failed (KMS):', err);
      return NextResponse.json({ error: 'trello_encrypt_failed' }, { status: 502 });
    }
    throw err;
  }
  const { error: upsertErr } = await service.from('trello_connections').upsert(
    {
      org_id: orgId,
      token_enc: tokenEnc,
      token_version: CRYPTO_VERSION.KMS_ESDK,
      member_id: member.id,
      username: member.username,
      expires_at: null,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'org_id' },
  );
  if (upsertErr !== null) {
    return NextResponse.json({ error: 'trello_store_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
