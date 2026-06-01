import { GithubClient } from '../../../src/skills/github/client.js';
import type { LiveSkillContext } from '../../../src/skills/github/live-context.js';
import type { GithubAccess, RepoTarget } from '../../../src/skills/github/source-resolver.js';
import type { SkillContext } from '@risezome/engine/skills';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** SkillContext stub — orgId is what the resolver keys on; db/now unused. */
export const SKILL_CTX: SkillContext = {
  db: null as never,
  orgId: 'test-org',
  now: () => 0,
};

/**
 * LiveSkillContext with a fake resolver returning a single installation
 * + repos. Pass a custom repo list to exercise multi-repo or specific
 * owner/name paths.
 */
export function liveCtx(
  fetchImpl: typeof fetch,
  repos: RepoTarget[] = [{ owner: 'o', name: 'r' }],
): LiveSkillContext {
  const client = new GithubClient({ fetchImpl });
  const access: GithubAccess = {
    installations: [{ installationId: 1, token: 'inst_tok', repos }],
  };
  return { client, resolve: async () => access };
}

/** Multi-installation context (two installs, each with its own repos). */
export function liveCtxMultiInstall(
  fetchImpl: typeof fetch,
  installs: { installationId: number; token: string; repos: RepoTarget[] }[],
): LiveSkillContext {
  const client = new GithubClient({ fetchImpl });
  return { client, resolve: async () => ({ installations: installs }) };
}

/** Resolver returns null — the org has no GitHub source connected. */
export function liveCtxNoSource(fetchImpl: typeof fetch = () => {
  throw new Error('fetch should not be called when no source is connected');
}): LiveSkillContext {
  const client = new GithubClient({ fetchImpl });
  return { client, resolve: async () => null };
}
