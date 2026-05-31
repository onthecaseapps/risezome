import { NextResponse, type NextRequest } from 'next/server';
import { getInstallationOctokit } from '../../../_lib/github-app';
import { createServiceRoleClient } from '../../../_lib/supabase-server';

/**
 * Completes the GitHub App install flow. GitHub redirects here after the
 * user finishes installing (or cancels):
 *
 *   /api/github/install-callback?installation_id=123&setup_action=install&state=...
 *
 * Three things happen here, in order:
 *   1. Verify `state` matches an unexpired pending_installations row. This
 *      binds the install to the user/org that initiated it.
 *   2. Fetch the installation metadata from GitHub (account login + type,
 *      list of repos). This authenticates as the installation itself, so
 *      it's the canonical source of truth — we don't trust the user's
 *      claimed org-id beyond the state binding.
 *   3. Upsert github_installations + insert one sources row per repo the
 *      user granted access to.
 *
 * Race note: the `installation.created` webhook fires roughly the same time
 * as this callback. The webhook handler upserts github_installations with
 * org_id NULL (it doesn't know which org), and this callback then sets the
 * org_id on the same row. Either ordering works thanks to the upsert.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const installationIdRaw = url.searchParams.get('installation_id');
  const setupAction = url.searchParams.get('setup_action');
  const state = url.searchParams.get('state');

  if (setupAction !== 'install' && setupAction !== 'update') {
    // The user hit "Cancel" on GitHub's install page, or some other
    // non-install setup_action. Send them back to sources with a benign
    // notice — no state to clean up since the install never happened.
    return NextResponse.redirect(new URL('/sources?notice=install_cancelled', url.origin));
  }

  if (installationIdRaw === null || state === null) {
    return NextResponse.redirect(new URL('/sources?error=install_missing_params', url.origin));
  }

  const installationId = Number.parseInt(installationIdRaw, 10);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return NextResponse.redirect(new URL('/sources?error=install_bad_id', url.origin));
  }

  const service = createServiceRoleClient();

  // Lookup + delete the pending row in two steps. We delete immediately so
  // the state can't be replayed, even if subsequent steps fail.
  const { data: pending, error: pendingErr } = await service
    .from('pending_installations')
    .select('org_id, user_id, expires_at')
    .eq('state_token', state)
    .maybeSingle();

  if (pendingErr !== null) {
    // eslint-disable-next-line no-console
    console.error('[install-callback] pending lookup failed:', pendingErr);
    return NextResponse.redirect(new URL('/sources?error=install_state_lookup_failed', url.origin));
  }
  if (pending === null) {
    return NextResponse.redirect(new URL('/sources?error=install_state_unknown', url.origin));
  }
  if (new Date(pending.expires_at as string) < new Date()) {
    await service.from('pending_installations').delete().eq('state_token', state);
    return NextResponse.redirect(new URL('/sources?error=install_state_expired', url.origin));
  }

  const orgId = pending.org_id as string;
  await service.from('pending_installations').delete().eq('state_token', state);

  // Fetch installation metadata from GitHub. Authenticates as the installation
  // itself — this is what tells us the account login + type + which repos
  // the user actually granted us. @octokit/app caches the installation token
  // internally; subsequent webhook handlers hit warm cache.
  let accountLogin: string;
  let accountType: 'Organization' | 'User';
  let repos: Array<{ id: number; full_name: string; default_branch: string }>;
  try {
    const octokit = await getInstallationOctokit(installationId);
    // GET /app/installations/{installation_id} returns the installation.
    // We use the installation-scoped token, so /installation/repositories
    // is the canonical list of repos the user granted access to.
    const inst = await octokit.request('GET /app/installations/{installation_id}', {
      installation_id: installationId,
    });
    accountLogin = (inst.data.account as { login: string }).login;
    accountType = ((inst.data.account as { type: string }).type === 'Organization'
      ? 'Organization'
      : 'User') as 'Organization' | 'User';

    const repoResp = await octokit.request('GET /installation/repositories', { per_page: 100 });
    repos = (repoResp.data.repositories as Array<{ id: number; full_name: string; default_branch: string }>).map(
      (r) => ({ id: r.id, full_name: r.full_name, default_branch: r.default_branch }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[install-callback] github fetch failed:', err);
    return NextResponse.redirect(new URL('/sources?error=install_github_fetch_failed', url.origin));
  }

  // Upsert the installation row. If the webhook beat us here, the row exists
  // with org_id = NULL; we set org_id + account metadata. If we beat the
  // webhook, the row is created here outright.
  const { error: upsertErr } = await service.from('github_installations').upsert(
    {
      installation_id: installationId,
      org_id: orgId,
      account_login: accountLogin,
      account_type: accountType,
    },
    { onConflict: 'installation_id' },
  );
  if (upsertErr !== null) {
    // eslint-disable-next-line no-console
    console.error('[install-callback] github_installations upsert failed:', upsertErr);
    return NextResponse.redirect(new URL('/sources?error=install_persist_failed', url.origin));
  }

  // Insert one sources row per granted repo. Webhook may also try to insert
  // these via installation_repositories.added — the unique (installation_id,
  // repo_full_name) constraint + onConflict: do-nothing keeps both paths idempotent.
  // After insert, fan out an Inngest event per newly-created source so the
  // indexer picks them up. We use `select()` on the upsert so we get back
  // the source ids regardless of whether we created the rows or they already
  // existed (the user re-installing the App).
  if (repos.length > 0) {
    const rows = repos.map((r) => ({
      org_id: orgId,
      installation_id: installationId,
      repo_full_name: r.full_name,
      repo_id: r.id,
      default_branch: r.default_branch,
      status: 'pending' as const,
    }));
    const { error: sourcesErr } = await service
      .from('sources')
      .upsert(rows, { onConflict: 'installation_id,repo_full_name', ignoreDuplicates: true });
    if (sourcesErr !== null) {
      // eslint-disable-next-line no-console
      console.error('[install-callback] sources insert failed:', sourcesErr);
      // Not fatal: the row exists, the user can refresh; webhook fills gaps.
    } else {
      // Re-select the source ids (ignoreDuplicates means upsert doesn't
      // return existing rows) and fan out index-requested events.
      const { data: persisted } = await service
        .from('sources')
        .select('id, repo_full_name')
        .eq('installation_id', installationId)
        .eq('org_id', orgId)
        .in('repo_full_name', repos.map((r) => r.full_name));

      if (persisted !== null && persisted.length > 0) {
        const { inngest } = await import('../../../../src/inngest/client');
        await inngest.send(
          persisted.map((s) => ({
            name: 'risezome/source.index-requested' as const,
            data: { orgId, sourceId: s.id as string, reason: 'install' as const },
          })),
        );
      }
    }
  }

  return NextResponse.redirect(new URL('/sources?installed=true', url.origin));
}
