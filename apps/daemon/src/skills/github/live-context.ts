import type { AuthResult } from '../../connectors/contract.js';
import type { GithubClient } from '../../connectors/github/client.js';

/**
 * Context closed over by live-API GitHub skills at registration time.
 * Built once per meeting (see `apps/daemon/src/cli/serve.ts`) and
 * captured in each skill factory's closure so the resulting `Skill`
 * objects are plain skill objects that fit the existing registry.
 *
 * Type-only file — no runtime exports.
 */
export interface LiveSkillContext {
  readonly client: GithubClient;
  readonly auth: AuthResult;
  readonly repo: { readonly owner: string; readonly name: string };
}
