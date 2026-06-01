import type { GithubClient } from './client.js';
import type { GithubSourceResolver } from './source-resolver.js';

/**
 * Context closed over by live-API GitHub skills at registration time.
 *
 * No longer carries a global token + single repo. Instead it carries a
 * shared HTTP client + a per-org resolver: at skill-call time the skill
 * calls `resolve(orgId)` to get the meeting org's installation tokens +
 * connected repos. This is the multi-tenant correction — each customer's
 * GitHub access comes from their own GitHub App installation (the
 * `sources` table), not a platform-wide PAT.
 */
export interface LiveSkillContext {
  readonly client: GithubClient;
  readonly resolve: GithubSourceResolver;
}
