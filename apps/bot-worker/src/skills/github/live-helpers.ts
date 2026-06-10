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
 * GitHub's Search API caps the whole query string at 256 chars. The repo:
 * qualifiers alone break that at ~8-10 connected repos, 422-ing the whole
 * skill — so repos are batched into groups whose joined `repo:` string
 * stays under this budget (leaving headroom for the filter qualifiers),
 * with one Search per group, merged by the callers below.
 */
const REPO_QUALIFIER_BUDGET = 230;

/** Group repos so each group's joined `repo:owner/name` string ≤ budget. */
export function batchRepoQualifiers(repos: readonly { owner: string; name: string }[]): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const r of repos) {
    const q = `repo:${r.owner}/${r.name}`;
    const extra = current.length === 0 ? q.length : q.length + 1; // +1 for the joining space
    if (current.length > 0 && length + extra > REPO_QUALIFIER_BUDGET) {
      batches.push(current.join(' '));
      current = [q];
      length = q.length;
    } else {
      current.push(q);
      length += extra;
    }
  }
  if (current.length > 0) batches.push(current.join(' '));
  return batches;
}

/**
 * Sum the `total_count` of a Search query across every connected repo —
 * one Search per (installation × repo batch); an installation token only
 * sees its own repos, and repo batches keep each query under GitHub's
 * 256-char cap. `qualifiers` is everything after the repo: scope, e.g.
 * `type:issue state:open assignee:nathan`. Batches are disjoint repo
 * sets, so summing their total_counts is exact.
 */
export async function searchIssuesCount(
  client: GithubClient,
  access: GithubAccess,
  qualifiers: string,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  for (const inst of access.installations) {
    for (const repoQ of batchRepoQualifiers(inst.repos)) {
      const q = `${repoQ} ${qualifiers}`.trim();
      const res = await client.getJson<{ total_count?: number }>(
        authForToken(inst.token),
        '/search/issues',
        { q, per_page: '1' },
        signal,
      );
      total += typeof res.total_count === 'number' ? res.total_count : 0;
    }
  }
  return total;
}

export interface SearchIssuesListResult {
  /** Top items, merged across batches, newest-updated first, capped at `limit`. */
  readonly items: GithubSearchItem[];
  /**
   * Exact match total across all repos (sum of disjoint batches'
   * total_count). May exceed items.length when the result is page-capped;
   * falls back to the page length when a response omits total_count.
   */
  readonly totalCount: number;
}

/**
 * Search issues/PRs across every connected repo, merge, sort newest-
 * updated first, and cap at `limit`. One Search per (installation × repo
 * batch) — see `batchRepoQualifiers` for the 256-char-cap rationale.
 */
export async function searchIssuesList(
  client: GithubClient,
  access: GithubAccess,
  qualifiers: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchIssuesListResult> {
  const all: GithubSearchItem[] = [];
  let totalCount = 0;
  for (const inst of access.installations) {
    for (const repoQ of batchRepoQualifiers(inst.repos)) {
      const q = `${repoQ} ${qualifiers}`.trim();
      const res = await client.getJson<{ items?: GithubSearchItem[]; total_count?: number }>(
        authForToken(inst.token),
        '/search/issues',
        { q, per_page: String(limit), sort: 'updated', order: 'desc' },
        signal,
      );
      const items = res.items ?? [];
      all.push(...items);
      totalCount += typeof res.total_count === 'number' ? res.total_count : items.length;
    }
  }
  all.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { items: all.slice(0, limit), totalCount };
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

/**
 * The unique GitHub account logins behind the org's connected repos (each
 * installation's repos share their installation account as owner). Used to
 * scope person resolution's user-search fallback to the workspace's own
 * accounts — an unscoped /search/users resolves a spoken "jamie" to a
 * global stranger and answers confidently about the wrong person.
 */
export function accountLogins(access: GithubAccess): string[] {
  const logins = new Set<string>();
  for (const inst of access.installations) {
    for (const repo of inst.repos) logins.add(repo.owner);
  }
  return [...logins];
}

/** Standard "this workspace hasn't connected GitHub" skill result. */
export const NO_GITHUB_SOURCE_SUMMARY =
  'No GitHub repository is connected to this workspace. Connect one on the Sources page to enable GitHub answers.';

/** The full not-connected result. `notConnected: true` lets the safety-net drop
 *  this CTA when real RAG sources exist (rather than surfacing it at rank 0). */
export const NO_GITHUB_SOURCE_RESULT = {
  kind: 'detail' as const,
  summary: NO_GITHUB_SOURCE_SUMMARY,
  notConnected: true,
};
