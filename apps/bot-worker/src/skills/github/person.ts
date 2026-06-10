import { ConnectorAuthError } from './connector-errors.js';
import type { GithubUser } from './types.js';
import type { GithubClient } from './client.js';
import { authForToken } from './live-helpers.js';

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

export interface ResolvePersonOptions {
  /**
   * Account logins to scope the user-search fallback to (the installations'
   * account owners — see `accountLogins`). When empty/absent the fallback is
   * SKIPPED entirely: an unscoped global /search/users resolves a spoken
   * "jamie" to a random stranger and produces a confidently wrong answer;
   * returning unresolved routes the skill to its self-heal/RAG path instead.
   */
  readonly orgs?: readonly string[] | undefined;
  /** Per-skill deadline signal (SkillContext.signal), threaded into fetch. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Try the token as a literal GitHub login first. On 404 specifically,
 * fall back to the user-search API — scoped to the installations' own
 * accounts via `org:` qualifiers — and pick the top match. Any other
 * error propagates to the caller (which wraps via `mapGithubError`).
 *
 * Returns `null` when:
 *   - the token doesn't match the GitHub login charset (rejected at gate)
 *   - the token is empty
 *   - the literal lookup 404s AND no org scope is available for the search
 *   - the literal lookup 404s AND the scoped search returns no matches
 */
export async function resolvePerson(
  client: GithubClient,
  token: string,
  personToken: string,
  options: ResolvePersonOptions = {},
): Promise<ResolvedPerson | null> {
  if (typeof personToken !== 'string') return null;
  if (!GITHUB_LOGIN_RE.test(personToken)) return null;
  const auth = authForToken(token);

  // 1. Try as literal login.
  try {
    const user = await client.getJson<GithubUser>(auth, `/users/${personToken}`, undefined, options.signal);
    return { login: user.login, resolved: 'literal' };
  } catch (err) {
    // Only suppress 404s. Anything else (rate-limit, auth-error, network)
    // propagates so the skill handler can map it via mapGithubError.
    if (!(err instanceof ConnectorAuthError) || err.status !== 404) {
      throw err;
    }
  }

  // 2. Fall back to user search, scoped to the installations' accounts.
  // Owners are re-validated against the login charset (same gate as the
  // person token) so nothing URL- or qualifier-active can be interpolated.
  // For a user-account installation `org:{login}` matches nothing — that
  // fails closed to "unresolved", which is the right trade: a wrong-person
  // answer is worse than no resolution.
  const orgs = (options.orgs ?? []).filter((o) => GITHUB_LOGIN_RE.test(o));
  if (orgs.length === 0) return null;
  // The person token has already passed the login charset regex above, so
  // by construction it cannot contain `:` or whitespace — qualifier syntax
  // (`org:victim`) is impossible here.
  const orgQ = orgs.map((o) => `org:${o}`).join(' ');
  const search = await client.getJson<GithubUserSearchResponse>(
    auth,
    '/search/users',
    { q: `${personToken} in:login in:name in:fullname ${orgQ}` },
    options.signal,
  );
  const top = search.items?.[0]?.login;
  if (typeof top !== 'string' || top.length === 0) return null;
  return { login: top, resolved: 'search' };
}
