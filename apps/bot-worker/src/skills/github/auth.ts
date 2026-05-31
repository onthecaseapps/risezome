/**
 * GitHub auth for bot-worker live skills.
 *
 * The daemon's auth.ts validates scopes against `/user`; the bot-worker
 * doesn't run a scope audit at startup — it trusts whatever
 * `GITHUB_TOKEN` provides and lets per-endpoint permission errors
 * surface through `mapGithubError`'s `auth-error` code at skill-call
 * time. Simpler, fewer startup round-trips, same observability.
 *
 * Single-repo constraint from the github-live-skills brainstorm
 * (D3): a per-meeting selection UI is deferred work; v1 pins to
 * `RISEZOME_GITHUB_REPO=owner/name`.
 */

import type { AuthResult } from './connector-errors.js';

export interface GithubRepo {
  readonly owner: string;
  readonly name: string;
}

export interface GithubEnv {
  readonly auth: AuthResult;
  readonly repo: GithubRepo;
}

/**
 * Read GITHUB_TOKEN + RISEZOME_GITHUB_REPO from the environment. Returns
 * null when either is absent — the caller (buildSkillRegistry) logs a
 * disabled-reason and skips live-skill registration. The legacy
 * UPWELL_GITHUB_REPO name is still honored as a fallback so already-set
 * deployment secrets keep working through the rename.
 */
export function readGithubEnv(env: NodeJS.ProcessEnv = process.env): GithubEnv | null {
  const token = env['GITHUB_TOKEN'];
  const repoSpec = env['RISEZOME_GITHUB_REPO'] ?? env['UPWELL_GITHUB_REPO'];
  if (token === undefined || token.length === 0) return null;
  if (repoSpec === undefined || repoSpec.length === 0) return null;
  const slash = repoSpec.indexOf('/');
  if (slash <= 0 || slash === repoSpec.length - 1) return null;
  const owner = repoSpec.slice(0, slash);
  const name = repoSpec.slice(slash + 1);
  return {
    auth: { kind: 'pat', token },
    repo: { owner, name },
  };
}
