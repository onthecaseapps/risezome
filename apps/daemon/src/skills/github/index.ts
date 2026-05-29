import type { Skill } from '../contract.js';
import { countSkill } from './count.js';
import { listSkill } from './list.js';
import { recentlyUpdatedSkill } from './recently_updated.js';
import { byAuthorSkill } from './by_author.js';

/**
 * The GitHub connector's v1 skill set. Registered into the SkillRegistry at
 * daemon startup. Order is stable for the classifier's tool list — count
 * appears first so the classifier biases toward it for ambiguous "how many"
 * utterances.
 */
export const skills: readonly Skill[] = [
  countSkill,
  listSkill,
  recentlyUpdatedSkill,
  byAuthorSkill,
];

export { countSkill, listSkill, recentlyUpdatedSkill, byAuthorSkill };
