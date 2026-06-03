'use server';

import { revalidatePath } from 'next/cache';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServiceRoleClient } from '../../_lib/supabase-server';
import { getInstallationOctokit } from '../../_lib/github-app';
import { inngest } from '../../../src/inngest/client';

/**
 * Repo settings for a GitHub source — list the repo's branches and change
 * which branch the indexer reads. The indexed branch is stored in
 * `sources.default_branch` (the indexer reads it, falling back to the repo's
 * live default when it's empty or 404s). Changing it re-indexes on the new
 * branch.
 */

export async function listRepoBranchesAction(
  sourceId: string,
): Promise<
  | { ok: true; branches: string[]; current: string | null }
  | { ok: false; error: string }
> {
  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const { data: source, error } = await service
    .from('sources')
    .select('id, installation_id, repo_full_name, default_branch')
    .eq('id', sourceId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error !== null || source === null) return { ok: false, error: 'source_not_found' };

  const installationId = source.installation_id as number | null;
  const repoFullName = source.repo_full_name as string | null;
  if (installationId === null || repoFullName === null) {
    return { ok: false, error: 'not_a_github_repo' };
  }
  const [owner, repo] = repoFullName.split('/');
  if (owner === undefined || repo === undefined) return { ok: false, error: 'bad_repo' };

  try {
    const octokit = await getInstallationOctokit(installationId);
    const branches: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const resp = await octokit.request('GET /repos/{owner}/{repo}/branches', {
        owner,
        repo,
        per_page: 100,
        page,
      });
      const names = (resp.data as { name: string }[]).map((b) => b.name);
      branches.push(...names);
      if (names.length < 100) break;
    }
    return { ok: true, branches, current: source.default_branch as string | null };
  } catch {
    return { ok: false, error: 'github_fetch_failed' };
  }
}

export async function setRepoBranchAction(
  sourceId: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof branch !== 'string' || branch.length === 0) return { ok: false, error: 'bad_branch' };

  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const { data: source, error } = await service
    .from('sources')
    .select('id, installation_id')
    .eq('id', sourceId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error !== null || source === null) return { ok: false, error: 'source_not_found' };
  if ((source.installation_id as number | null) === null) {
    return { ok: false, error: 'not_a_github_repo' };
  }

  // Point the source at the chosen branch and re-index it. Mark pending so
  // the UI flips immediately; the indexer transitions to 'indexing'.
  const { error: updErr } = await service
    .from('sources')
    .update({ default_branch: branch, status: 'pending', status_message: null })
    .eq('id', sourceId)
    .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
  if (updErr !== null) return { ok: false, error: updErr.message };

  await inngest.send({
    name: 'risezome/source.index-requested',
    data: { orgId, sourceId, reason: 'reindex', mode: 'full' },
  });

  revalidatePath('/sources');
  return { ok: true };
}
