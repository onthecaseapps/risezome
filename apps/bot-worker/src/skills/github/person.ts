import { ConnectorAuthError } from './connector-errors.js';
import type { GithubUser } from './types.js';
import type { LiveSkillContext } from './live-context.js';

export interface ResolvedPerson {
  readonly login: string;
  readonly resolved: 'literal' | 'search';
}

/**
 * GitHub's documented login charset. Letters, digits, hyphens, and
 * underscores are permitted; underscore is non-canonical (GitHub allows
 * them in API paths even though sign-up forbids them) so the regex
 * accepts both. Max length 39 characters per GitHub's login rules.
 *
 * This is a SECURITY GATE: spoken tokens land here from the meeting
 * transcript via the classifier's tool_use args. Anything containing
 * `/`, `..`, whitespace, `:`, or other URL-active characters would
 * traverse to unintended GitHub API endpoints once interpolated into
 * `/users/${token}`. Rejecting at the regex layer (return null, no API
 * call fires) eliminates the injection surface entirely.
 */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;

interface GithubUserSearchResponse {
  readonly items?: readonly { readonly login: string }[];
}

/**
 * Try the token as a literal GitHub login first. On 404 specifically,
 * fall back to the user-search API and pick the top match. Any other
 * error propagates to the caller (which wraps via `mapGithubError`).
 *
 * Returns `null` when:
 *   - the token doesn't match the GitHub login charset (rejected at gate)
 *   - the token is empty
 *   - the literal lookup 404s AND the search returns no matches
 */
export async function resolvePerson(
  token: string,
  ctx: LiveSkillContext,
): Promise<ResolvedPerson | null> {
  if (typeof token !== 'string') return null;
  if (!GITHUB_LOGIN_RE.test(token)) return null;

  // 1. Try as literal login.
  try {
    const user = await ctx.client.getJson<GithubUser>(ctx.auth, `/users/${token}`);
    return { login: user.login, resolved: 'literal' };
  } catch (err) {
    // Only suppress 404s. Anything else (rate-limit, auth-error, network)
    // propagates so the skill handler can map it via mapGithubError.
    if (!(err instanceof ConnectorAuthError) || err.status !== 404) {
      throw err;
    }
  }

  // 2. Fall back to user search. The token has already passed the login
  // charset regex above, so by construction it cannot contain `:` or
  // whitespace — qualifier syntax (`org:victim`) is impossible here.
  const search = await ctx.client.getJson<GithubUserSearchResponse>(ctx.auth, '/search/users', {
    q: `${token} in:login in:name in:fullname`,
  });
  const top = search.items?.[0]?.login;
  if (typeof top !== 'string' || top.length === 0) return null;
  return { login: top, resolved: 'search' };
}
