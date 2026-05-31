import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceRoleClient } from '../../../_lib/supabase-server';

/**
 * GitHub App webhook receiver. GitHub POSTs lifecycle events here:
 *
 *   - installation.created        → org installed the App. We may have
 *                                    already created the row from the
 *                                    install-callback; either path is idempotent.
 *   - installation.deleted        → org uninstalled. Soft-delete the
 *                                    installation + cascade soft-delete all
 *                                    its sources so the indexer stops touching them.
 *   - installation.suspend        → org suspended the App. Mark suspended_at;
 *                                    the indexer should pause.
 *   - installation.unsuspend      → org reactivated. Clear suspended_at.
 *   - installation_repositories.added   → repos granted post-install.
 *   - installation_repositories.removed → repos revoked post-install.
 *
 * Signature verification: GitHub signs the raw request body with
 * GITHUB_APP_WEBHOOK_SECRET as HMAC-SHA-256, sent in `X-Hub-Signature-256`
 * as `sha256=<hex>`. We verify with a constant-time comparison before doing
 * anything else. Verification failures return 401 — never 500, never leak
 * timing info.
 *
 * Why explicit verification instead of @octokit/webhooks: this handler does
 * a few discrete database writes per event; pulling in the webhooks
 * abstraction would add a layer without removing meaningful code. The
 * verification is ~15 lines and stays close to the routing.
 */

export const dynamic = 'force-dynamic';

interface InstallationEventPayload {
  action: string;
  installation: {
    id: number;
    account: { login: string; type: string };
    suspended_at: string | null;
  };
  repositories?: Array<{ id: number; full_name: string }>;
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const signature = request.headers.get('x-hub-signature-256');
  const event = request.headers.get('x-github-event');
  const deliveryId = request.headers.get('x-github-delivery') ?? 'unknown';

  if (signature === null || event === null) {
    return new NextResponse('Missing signature or event header', { status: 400 });
  }

  const secret = process.env['GITHUB_APP_WEBHOOK_SECRET'];
  if (secret === undefined || secret.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[github.webhook] GITHUB_APP_WEBHOOK_SECRET not set');
    return new NextResponse('Server misconfigured', { status: 500 });
  }

  // Must read the body as raw bytes for HMAC; reading as JSON first would
  // round-trip through a parse/stringify cycle and break the signature.
  const rawBody = await request.text();
  if (!verifySignature(rawBody, signature, secret)) {
    // eslint-disable-next-line no-console
    console.warn(`[github.webhook] signature mismatch (delivery=${deliveryId}, event=${event})`);
    return new NextResponse('Invalid signature', { status: 401 });
  }

  if (event === 'ping') {
    return NextResponse.json({ ok: true });
  }

  // We only care about installation and installation_repositories events for
  // U4b. push/pull_request/issues (subscribed in the manifest) flow to the
  // indexer in a later unit; ignore them here for now.
  if (event !== 'installation' && event !== 'installation_repositories') {
    return NextResponse.json({ ok: true, ignored: event });
  }

  let payload: InstallationEventPayload;
  try {
    payload = JSON.parse(rawBody) as InstallationEventPayload;
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }

  const service = createServiceRoleClient();
  const installationId = payload.installation.id;

  if (event === 'installation') {
    await handleInstallationEvent(service, payload, installationId);
  } else {
    await handleInstallationRepositoriesEvent(service, payload, installationId);
  }

  return NextResponse.json({ ok: true });
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

async function handleInstallationEvent(
  service: ReturnType<typeof createServiceRoleClient>,
  payload: InstallationEventPayload,
  installationId: number,
): Promise<void> {
  const action = payload.action;
  const account = payload.installation.account;
  const accountType: 'Organization' | 'User' = account.type === 'Organization' ? 'Organization' : 'User';

  if (action === 'created') {
    // org_id is unknown to the webhook — the install-callback knows it via
    // the state binding. Race-tolerant insert: if the callback beat us here
    // (row exists with org_id already set), ignoreDuplicates leaves it
    // alone. If we beat the callback, we create the row with org_id NULL
    // and the callback sets it via its own upsert.
    const { error: directErr } = await service.from('github_installations').upsert(
      {
        installation_id: installationId,
        account_login: account.login,
        account_type: accountType,
      },
      { onConflict: 'installation_id', ignoreDuplicates: true },
    );
    if (directErr !== null) {
      // eslint-disable-next-line no-console
      console.error('[github.webhook] installation.created upsert failed:', directErr);
    }

    // Also stamp initial sources rows for any repos in the payload. The
    // callback may have already done this; ignoreDuplicates keeps it safe.
    if (payload.repositories !== undefined && payload.repositories.length > 0) {
      // We don't know org_id from the webhook. Look it up from the installation
      // row; if NULL (callback hasn't fired yet), skip — the callback will
      // create the sources rows when it sets org_id.
      const orgId = await getOrgIdForInstallation(service, installationId);
      if (orgId !== null) {
        const rows = payload.repositories.map((r) => ({
          org_id: orgId,
          installation_id: installationId,
          repo_full_name: r.full_name,
          repo_id: r.id,
          status: 'pending' as const,
        }));
        const { error: srcErr } = await service
          .from('sources')
          .upsert(rows, { onConflict: 'installation_id,repo_full_name', ignoreDuplicates: true });
        if (srcErr !== null) {
          // eslint-disable-next-line no-console
          console.error('[github.webhook] sources backfill failed:', srcErr);
        }
      }
    }
    return;
  }

  if (action === 'deleted') {
    const now = new Date().toISOString();
    await service.from('github_installations').update({ removed_at: now }).eq('installation_id', installationId);
    await service
      .from('sources')
      .update({ status: 'removed', removed_at: now })
      .eq('installation_id', installationId)
      .is('removed_at', null);
    return;
  }

  if (action === 'suspend') {
    await service
      .from('github_installations')
      .update({ suspended_at: new Date().toISOString() })
      .eq('installation_id', installationId);
    return;
  }

  if (action === 'unsuspend') {
    await service
      .from('github_installations')
      .update({ suspended_at: null })
      .eq('installation_id', installationId);
    return;
  }

  // new_permissions_accepted, etc — no-op for now.
}

async function handleInstallationRepositoriesEvent(
  service: ReturnType<typeof createServiceRoleClient>,
  payload: InstallationEventPayload,
  installationId: number,
): Promise<void> {
  const orgId = await getOrgIdForInstallation(service, installationId);

  const added = payload.repositories_added ?? [];
  if (added.length > 0 && orgId !== null) {
    const rows = added.map((r) => ({
      org_id: orgId,
      installation_id: installationId,
      repo_full_name: r.full_name,
      repo_id: r.id,
      status: 'pending' as const,
    }));
    const { error } = await service
      .from('sources')
      .upsert(rows, { onConflict: 'installation_id,repo_full_name', ignoreDuplicates: true });
    if (error !== null) {
      // eslint-disable-next-line no-console
      console.error('[github.webhook] installation_repositories.added failed:', error);
    }
  }

  const removed = payload.repositories_removed ?? [];
  if (removed.length > 0) {
    const now = new Date().toISOString();
    const fullNames = removed.map((r) => r.full_name);
    await service
      .from('sources')
      .update({ status: 'removed', removed_at: now })
      .eq('installation_id', installationId)
      .in('repo_full_name', fullNames);
  }
}

async function getOrgIdForInstallation(
  service: ReturnType<typeof createServiceRoleClient>,
  installationId: number,
): Promise<string | null> {
  const { data, error } = await service
    .from('github_installations')
    .select('org_id')
    .eq('installation_id', installationId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return (data.org_id as string | null) ?? null;
}
