export interface GithubUser {
  readonly login: string;
  readonly html_url: string;
}

export interface GithubRepo {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly html_url: string;
  readonly description: string | null;
  readonly default_branch: string;
}

export interface GithubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly html_url: string;
  readonly body: string | null;
  readonly user: { readonly login: string };
  readonly assignees: readonly { readonly login: string }[];
  readonly labels: readonly { readonly name: string }[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly pull_request?: { readonly url: string };
  readonly comments_inline?: readonly GithubComment[];
}

export interface GithubComment {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface GithubRateLimit {
  readonly remaining: number;
  readonly limit: number;
  readonly reset: number;
}
