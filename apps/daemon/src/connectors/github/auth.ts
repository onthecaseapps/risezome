import type { AuthOutcome, AuthResult } from '../contract.js';
import { ConnectorAuthError } from '../contract.js';
import { type GithubClient } from './client.js';
import type { GithubUser } from './types.js';

export const GITHUB_REQUIRED_SCOPES: readonly string[] = ['repo', 'read:user'];
export const GITHUB_PRIVILEGED_SCOPES: readonly string[] = [
  'admin:org',
  'admin:repo_hook',
  'delete_repo',
  'workflow',
];

export interface ScopeAuditResult {
  readonly grantedScopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly excessiveScopes: readonly string[];
}

export async function authenticate(client: GithubClient, auth: AuthResult): Promise<AuthOutcome> {
  let user: GithubUser;
  let scopesHeader: string | null;
  try {
    const res = await client.get(auth, '/user');
    user = (await res.json()) as GithubUser;
    scopesHeader = res.headers.get('x-oauth-scopes');
  } catch (err) {
    if (err instanceof ConnectorAuthError) {
      return {
        ok: false,
        reason: 'invalid-credentials',
        grantedScopes: [],
        missingScopes: [...GITHUB_REQUIRED_SCOPES],
      };
    }
    throw err;
  }

  // Fine-grained PATs do not populate the X-OAuth-Scopes response header
  // (it's only set on responses to classic OAuth-token / classic-PAT requests).
  // /user succeeding with no scopes header means the caller picked per-repo
  // permissions explicitly at PAT creation time; trust that choice here and
  // let per-endpoint permission mismatches surface as 403 on the actual
  // resource call (pullDelta, clone, etc.) where the error is specific.
  if (scopesHeader === null) {
    return {
      ok: true,
      grantedScopes: [],
      missingScopes: [],
      identity: { login: user.login, url: user.html_url },
    };
  }

  const audit = auditScopes(parseScopesHeader(scopesHeader));
  return {
    ok: audit.missingScopes.length === 0,
    ...(audit.missingScopes.length > 0 ? { reason: 'insufficient-scope' as const } : {}),
    grantedScopes: audit.grantedScopes,
    missingScopes: audit.missingScopes,
    identity: { login: user.login, url: user.html_url },
  };
}

export function parseScopesHeader(header: string | null): readonly string[] {
  if (header === null || header.trim().length === 0) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function auditScopes(granted: readonly string[]): ScopeAuditResult {
  const set = new Set(granted);
  const missing = GITHUB_REQUIRED_SCOPES.filter(
    (s) => !set.has(s) && !grantedImpliesRequired(set, s),
  );
  const excessive = GITHUB_PRIVILEGED_SCOPES.filter((s) => set.has(s));
  return {
    grantedScopes: granted,
    missingScopes: missing,
    excessiveScopes: excessive,
  };
}

function grantedImpliesRequired(granted: Set<string>, required: string): boolean {
  // GitHub PAT scope hierarchy: 'repo' covers 'public_repo'; 'read:user' is implied by 'user'.
  if (required === 'read:user' && granted.has('user')) return true;
  if (required === 'repo' && granted.has('public_repo') && !granted.has('repo')) return false;
  return false;
}
