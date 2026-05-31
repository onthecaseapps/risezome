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

export interface BuildSkillRegistryOptions {
  readonly logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
}

export function buildSkillRegistry(options: BuildSkillRegistryOptions): SkillRegistry {
  const registry = new SkillRegistry();

  // U4 (live-API GitHub skills) and U6 (Postgres corpus GitHub
  // skills) register their skills here once they land. Each block
  // gates on env-var presence so an unconfigured environment yields
  // a smaller registry instead of erroring at startup.

  options.logger.info(
    { registeredSkills: registry.list().map((s) => s.name) },
    'skills.registry.built',
  );

  return registry;
}
