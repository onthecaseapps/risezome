/**
 * Bot-worker skill set assembly.
 *
 * The classifier's tool surface is built from whichever skills are
 * configured at startup time. Live-API skills (U4) register when
 * GITHUB_TOKEN + UPWELL_GITHUB_REPO are set; corpus skills (U6)
 * register when the Postgres corpus has issues + PRs indexed (U5
 * lands the indexer in production).
 *
 * The registry is a process-singleton; skills themselves are
 * stateless or close over the LiveSkillContext built once at
 * startup. Per-meeting state goes in the SkillContext.db / orgId,
 * not on the registry.
 */

import { SkillRegistry } from '@risezome/engine/skills';
import { GithubClient } from './github/client.js';
import { readGithubEnv } from './github/auth.js';
import type { LiveSkillContext } from './github/live-context.js';
import { buildIssueAssigneesSkill } from './github/issue_assignees.js';
import { buildByAssigneeCountSkill } from './github/by_assignee_count.js';
import { buildByAssigneeListSkill } from './github/by_assignee_list.js';
import { buildIssueProgressSkill } from './github/issue_progress.js';

export interface BuildSkillRegistryOptions {
  readonly logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
}

export function buildSkillRegistry(options: BuildSkillRegistryOptions): SkillRegistry {
  const registry = new SkillRegistry();

  // ── Live-API GitHub skills (U4) ─────────────────────────────────
  // Register when both GITHUB_TOKEN and UPWELL_GITHUB_REPO are
  // configured. Either missing logs a disable-reason and skips
  // registration — the corpus skills (U6) and the rest of the
  // pipeline still work.
  const githubEnv = readGithubEnv();
  if (githubEnv === null) {
    options.logger.info(
      {
        hasToken: process.env['GITHUB_TOKEN'] !== undefined,
        hasRepo: process.env['UPWELL_GITHUB_REPO'] !== undefined,
      },
      'github.live.disabled',
    );
  } else {
    const githubClient = new GithubClient({});
    const liveContext: LiveSkillContext = {
      client: githubClient,
      auth: githubEnv.auth,
      repo: githubEnv.repo,
    };
    registry.register(buildIssueAssigneesSkill(liveContext));
    registry.register(buildByAssigneeCountSkill(liveContext));
    registry.register(buildByAssigneeListSkill(liveContext));
    registry.register(buildIssueProgressSkill(liveContext));
    options.logger.info(
      { repo: `${githubEnv.repo.owner}/${githubEnv.repo.name}` },
      'github.live.enabled',
    );
  }

  // ── Corpus GitHub skills (U6) ───────────────────────────────────
  // Registered after the portal-side issue/PR indexer (U5) lands.
  // Today: not yet wired.

  options.logger.info(
    { registeredSkills: registry.list().map((s) => s.name) },
    'skills.registry.built',
  );

  return registry;
}
