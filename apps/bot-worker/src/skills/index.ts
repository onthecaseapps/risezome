/**
 * Bot-worker skill set assembly.
 *
 * The classifier's tool surface is built from whichever skills are
 * configured at startup time. Live-API skills (U4) register when
 * GITHUB_TOKEN + RISEZOME_GITHUB_REPO are set; corpus skills (U6)
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
import { buildSearchCountSkill } from './github/search_count.js';
import { countSkill } from './github/count.js';
import { listSkill } from './github/list.js';
import { byAuthorSkill } from './github/by_author.js';
import { recentlyUpdatedSkill } from './github/recently_updated.js';

export interface BuildSkillRegistryOptions {
  readonly logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
}

export function buildSkillRegistry(options: BuildSkillRegistryOptions): SkillRegistry {
  const registry = new SkillRegistry();

  // ── Live-API GitHub skills (U4) ─────────────────────────────────
  // Register when both GITHUB_TOKEN and RISEZOME_GITHUB_REPO are
  // configured. Either missing logs a disable-reason and skips
  // registration — the corpus skills (U6) and the rest of the
  // pipeline still work.
  const githubEnv = readGithubEnv();
  const githubLive = githubEnv !== null;
  if (githubEnv === null) {
    options.logger.info(
      {
        hasToken: process.env.GITHUB_TOKEN !== undefined,
        hasRepo:
          process.env.RISEZOME_GITHUB_REPO !== undefined ||
          process.env.UPWELL_GITHUB_REPO !== undefined,
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
    // Live github_count via the Search API (total_count in one request)
    // — registered FIRST so it claims the `github_count` name before
    // the corpus fallback below. Fresh, no indexer dependency.
    registry.register(buildSearchCountSkill(liveContext));
    registry.register(buildIssueAssigneesSkill(liveContext));
    registry.register(buildByAssigneeCountSkill(liveContext));
    registry.register(buildByAssigneeListSkill(liveContext));
    registry.register(buildIssueProgressSkill(liveContext));
    options.logger.info(
      { repo: `${githubEnv.repo.owner}/${githubEnv.repo.name}` },
      'github.live.enabled',
    );
  }

  // ── Corpus GitHub skills ────────────────────────────────────────
  // Stateless; ctx.db is provided per call. When live is enabled the
  // Search-API count above already owns `github_count`, so the corpus
  // count is skipped to avoid a duplicate-name registry error — the
  // live count is strictly fresher. list / by_author / recently_updated
  // remain corpus-backed (listing all matches live would require
  // pagination the corpus avoids); they return zero-result summaries
  // cleanly until the issue indexer has populated the corpus.
  //
  // Order matches the daemon's apps/daemon/src/skills/github/index.ts:
  // count first so the classifier biases toward it for ambiguous
  // "how many" utterances.
  if (!githubLive) {
    registry.register(countSkill);
  }
  registry.register(listSkill);
  registry.register(recentlyUpdatedSkill);
  registry.register(byAuthorSkill);

  options.logger.info(
    { registeredSkills: registry.list().map((s) => s.name) },
    'skills.registry.built',
  );

  return registry;
}
