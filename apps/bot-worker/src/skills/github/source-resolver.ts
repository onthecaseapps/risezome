import type { SupabaseClient } from '@supabase/supabase-js';
import type { GithubAppAuth } from './app-auth.js';

/**
 * Per-org GitHub access, resolved at skill-call time from the meeting's
 * orgId. Replaces the global GITHUB_TOKEN PAT: each customer connects
 * GitHub through the Sources page (GitHub App install), and the skills
 * use that installation's token scoped to that customer's repos.
 *
 * An org can connect several repos, possibly across more than one
 * installation (one App install per GitHub org/account). Sources are
 * grouped by installation_id because an installation token is scoped to
 * a single installation — a multi-repo Search has to run once per
 * installation and aggregate.
 */

export interface RepoTarget {
  readonly owner: string;
  readonly name: string;
}

export interface InstallationAccess {
  readonly installationId: number;
  /** Installation access token valid for all repos under this installation. */
  readonly token: string;
  readonly repos: readonly RepoTarget[];
}

export interface GithubAccess {
  readonly installations: readonly InstallationAccess[];
}

/** orgId → access, or null when the org has no GitHub source connected. */
export type GithubSourceResolver = (orgId: string) => Promise<GithubAccess | null>;

interface SourceRow {
  readonly installation_id: number;
  readonly repo_full_name: string;
}

export function buildGithubSourceResolver(deps: {
  db: SupabaseClient;
  appAuth: GithubAppAuth;
}): GithubSourceResolver {
  return async (orgId: string): Promise<GithubAccess | null> => {
    const { data, error } = await deps.db
      .from('sources')
      .select('installation_id, repo_full_name')
      .eq('org_id', orgId)
      .eq('kind', 'github')
      .neq('status', 'removed');
    if (error !== null) {
      throw new Error(`sources lookup failed for org ${orgId}: ${error.message}`);
    }
    const rows = (data ?? []) as SourceRow[];
    if (rows.length === 0) return null;

    // Group repos by installation — one token per installation.
    const byInstallation = new Map<number, RepoTarget[]>();
    for (const row of rows) {
      if (typeof row.installation_id !== 'number' || typeof row.repo_full_name !== 'string') {
        continue;
      }
      const slash = row.repo_full_name.indexOf('/');
      if (slash <= 0 || slash === row.repo_full_name.length - 1) continue;
      const owner = row.repo_full_name.slice(0, slash);
      const name = row.repo_full_name.slice(slash + 1);
      const repos = byInstallation.get(row.installation_id) ?? [];
      repos.push({ owner, name });
      byInstallation.set(row.installation_id, repos);
    }
    if (byInstallation.size === 0) return null;

    const installations: InstallationAccess[] = [];
    for (const [installationId, repos] of byInstallation) {
      const token = await deps.appAuth.installationToken(installationId);
      installations.push({ installationId, token, repos });
    }
    return { installations };
  };
}
