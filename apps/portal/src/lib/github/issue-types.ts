/**
 * GitHub issue + PR types used by the portal's issue indexer.
 *
 * Mirrors the relevant subset of `apps/daemon/src/connectors/github/types.ts`.
 * Forcing function for shared package: same as the bot-worker copy — next
 * GitHub-client bug fix extracts to `packages/connectors-github/`.
 */

export interface GithubIssueUser {
  readonly login: string;
}

export interface GithubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly html_url: string;
  readonly body: string | null;
  readonly user: GithubIssueUser;
  readonly assignees: readonly GithubIssueUser[];
  readonly labels: readonly { readonly name: string }[];
  readonly created_at: string;
  readonly updated_at: string;
  /** Present when the row is a PR (GitHub's /issues endpoint returns both;
   *  `pull_request` is the discriminator). */
  readonly pull_request?: { readonly url: string };
}
