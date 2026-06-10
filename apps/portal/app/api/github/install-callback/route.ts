import { NextResponse, type NextRequest } from 'next/server';
import { getInstallationOctokit } from '../../../_lib/github-app';
import { createServiceRoleClient } from '../../../_lib/supabase-server';

/**
 * How fresh a webhook-created NULL-org skeleton must be to be adoptable by a
 * completing install flow. Matches the pending_installations 15-minute state
 * lifetime: the install webhook fires seconds before this callback, so a
 * legitimately in-flight skeleton is always well within this window; anything
 * older is an abandoned skeleton (e.g. a direct-from-GitHub install) that must
 * not be adoptable by a crafted callback. (See the claim-guard comment below.)
 */
const CLAIMABLE_SKELETON_MAX_AGE_MS = 15 * 60 * 1000;

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
  // service-role-cross-org: OAuth callback has no org in scope yet; the unguessable
  // single-use state_token IS the cross-org-safe key that resolves org_id.
  const { data: pending, error: pendingErr } = await service
    .from('pending_installations')
    .select('org_id, user_id, expires_at')
    .eq('state_token', state)
    .maybeSingle();

  if (pendingErr !== null) {
     
    console.error('[install-callback] pending lookup failed:', pendingErr);
    return NextResponse.redirect(new URL('/sources?error=install_state_lookup_failed', url.origin));
  }
  if (pending === null) {
    return NextResponse.redirect(new URL('/sources?error=install_state_unknown', url.origin));
  }
  if (new Date(pending.expires_at as string) < new Date()) {
    // service-role-cross-org: delete keyed by the same unguessable state_token.
    await service.from('pending_installations').delete().eq('state_token', state);
    return NextResponse.redirect(new URL('/sources?error=install_state_expired', url.origin));
  }

  const orgId = pending.org_id as string;
  // service-role-cross-org: delete keyed by the same unguessable state_token.
  await service.from('pending_installations').delete().eq('state_token', state);

  // SECURITY — installation-claim guard. `installation_id` comes from the query
  // string, i.e. the CALLER chooses it, and installation ids are small
  // enumerable integers. There is no cryptographic binding between the state
  // (which proves the caller's org) and the installation_id (which the caller
  // supplies), so two abuses must be blocked:
  //   1. Overwriting another org's installation — refused below: a row whose
  //      org_id is already set to a different org is never re-claimed.
  //   2. Adopting a stranger's UNCLAIMED (org_id NULL) skeleton. The webhook
  //      creates a NULL-org skeleton on every install — including direct-from-
  //      GitHub installs that never finish our flow — and those sit NULL
  //      indefinitely. Without a freshness bound, an attacker could enumerate
  //      installation ids and adopt a victim's long-abandoned skeleton, pulling
  //      their PRIVATE repos into the attacker's org. The legitimate flow has
  //      the webhook fire SECONDS before this callback, so a NULL skeleton is
  //      only claimable while it is FRESH (within the pending-state window);
  //      stale NULL skeletons are refused here and reaped by retention-sweeps.
  const { data: claimed, error: claimErr } = await service
    .from('github_installations')
    .select('org_id, installed_at')
    .eq('installation_id', installationId)
    .maybeSingle();
  if (claimErr !== null) {
    console.error('[install-callback] claim lookup failed:', claimErr);
    return NextResponse.redirect(new URL('/sources?error=install_persist_failed', url.origin));
  }
  if (claimed !== null && claimed.org_id !== null && claimed.org_id !== orgId) {
    console.error(
      `[install-callback] REFUSED cross-org installation claim: installation ${String(installationId)} belongs to another org (attempted org=${orgId})`,
    );
    return NextResponse.redirect(new URL('/sources?error=install_already_claimed', url.origin));
  }
  if (claimed !== null && claimed.org_id === null) {
    const ageMs = Date.now() - new Date(claimed.installed_at as string).getTime();
    if (ageMs > CLAIMABLE_SKELETON_MAX_AGE_MS) {
      console.error(
        `[install-callback] REFUSED stale unclaimed-skeleton adoption: installation ${String(installationId)} skeleton is ${String(Math.round(ageMs / 60000))}min old (attempted org=${orgId})`,
      );
      return NextResponse.redirect(new URL('/sources?error=install_already_claimed', url.origin));
    }
  }

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
     
    console.error('[install-callback] github fetch failed:', err);
    return NextResponse.redirect(new URL('/sources?error=install_github_fetch_failed', url.origin));
  }

  // Persist the installation row WITHOUT ever overwriting another org's claim
  // (closing the TOCTOU window the pre-check above leaves): insert a skeleton
  // if missing, then a GUARDED update that only claims rows that are unclaimed
  // (webhook-created, org_id NULL) or already ours.
  const { error: insertErr } = await service.from('github_installations').upsert(
    {
      installation_id: installationId,
      org_id: orgId,
      account_login: accountLogin,
      account_type: accountType,
    },
    { onConflict: 'installation_id', ignoreDuplicates: true },
  );
  if (insertErr !== null) {
    console.error('[install-callback] github_installations insert failed:', insertErr);
    return NextResponse.redirect(new URL('/sources?error=install_persist_failed', url.origin));
  }
  const { data: claimedRows, error: updateErr } = await service
    .from('github_installations')
    .update({ org_id: orgId, account_login: accountLogin, account_type: accountType })
    .eq('installation_id', installationId)
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .select('installation_id');
  if (updateErr !== null) {
    console.error('[install-callback] github_installations claim failed:', updateErr);
    return NextResponse.redirect(new URL('/sources?error=install_persist_failed', url.origin));
  }
  if (claimedRows === null || claimedRows.length === 0) {
    // Lost the race to another org's concurrent claim — same refusal as above.
    console.error(
      `[install-callback] REFUSED cross-org installation claim (race): installation ${String(installationId)} (attempted org=${orgId})`,
    );
    return NextResponse.redirect(new URL('/sources?error=install_already_claimed', url.origin));
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
            data: { orgId, sourceId: s.id as string, reason: 'install' as const, mode: 'full' as const },
          })),
        );
      }
    }
  }

  return NextResponse.redirect(new URL('/sources?installed=true', url.origin));
}
