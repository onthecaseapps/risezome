import type { AuthResult } from './connector-errors.js';
import type { GithubClient } from './client.js';
import type { GithubAccess } from './source-resolver.js';

/** Wrap an installation token in the AuthResult the GithubClient expects. */
export function authForToken(token: string): AuthResult {
  return { kind: 'oauth2', accessToken: token };
}

/**
 * One item from GitHub's /search/issues response. Both issues and PRs
 * come back; `pull_request` is the PR discriminator.
 */
export interface GithubSearchItem {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly state: 'open' | 'closed';
  readonly updated_at: string;
  readonly repository_url: string;
  readonly pull_request?: unknown;
  readonly assignees?: readonly { readonly login: string }[];
  readonly user?: { readonly login: string };
}

/**
 * Sum the `total_count` of a Search query across every connected repo,
 * one Search per installation (an installation token only sees its own
 * repos). `qualifiers` is everything after the repo: scope, e.g.
 * `type:issue state:open assignee:nathan`.
 */
export async function searchIssuesCount(
  client: GithubClient,
  access: GithubAccess,
  qualifiers: string,
): Promise<number> {
  let total = 0;
  for (const inst of access.installations) {
    const repoQ = inst.repos.map((r) => `repo:${r.owner}/${r.name}`).join(' ');
    const q = `${repoQ} ${qualifiers}`.trim();
    const res = await client.getJson<{ total_count?: number }>(
      authForToken(inst.token),
      '/search/issues',
      { q, per_page: '1' },
    );
    total += typeof res.total_count === 'number' ? res.total_count : 0;
  }
  return total;
}

/**
 * Search issues/PRs across every connected repo, merge, sort newest-
 * updated first, and cap at `limit`. One Search per installation.
 */
export async function searchIssuesList(
  client: GithubClient,
  access: GithubAccess,
  qualifiers: string,
  limit: number,
): Promise<GithubSearchItem[]> {
  const all: GithubSearchItem[] = [];
  for (const inst of access.installations) {
    const repoQ = inst.repos.map((r) => `repo:${r.owner}/${r.name}`).join(' ');
    const q = `${repoQ} ${qualifiers}`.trim();
    const res = await client.getJson<{ items?: GithubSearchItem[] }>(
      authForToken(inst.token),
      '/search/issues',
      { q, per_page: String(limit), sort: 'updated', order: 'desc' },
    );
    all.push(...(res.items ?? []));
  }
  all.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return all.slice(0, limit);
}

/**
 * The first connected repo (with its installation token). Issue-number
 * skills (issue_assignees, issue_progress) need a single repo because an
 * issue number is repo-scoped; until repo-routing lands (issue #31) they
 * target this one. Returns null when no repos are connected.
 */
export function firstRepo(
  access: GithubAccess,
): { readonly token: string; readonly owner: string; readonly name: string } | null {
  for (const inst of access.installations) {
    const repo = inst.repos[0];
    if (repo !== undefined) return { token: inst.token, owner: repo.owner, name: repo.name };
  }
  return null;
}

/** A token for global (non-repo-scoped) endpoints: /users, /search/users. */
export function anyToken(access: GithubAccess): string | null {
  return access.installations[0]?.token ?? null;
}

/** Standard "this workspace hasn't connected GitHub" skill result. */
export const NO_GITHUB_SOURCE_SUMMARY =
  'No GitHub repository is connected to this workspace. Connect one on the Sources page to enable GitHub answers.';
