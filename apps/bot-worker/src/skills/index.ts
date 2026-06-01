/**
 * Bot-worker skill set assembly.
 *
 * The classifier's tool surface is built once at startup from whichever
 * skills are configured.
 *
 * GitHub auth is multi-tenant: the live skills resolve each meeting
 * org's GitHub App installation token(s) + connected repos from the
 * `sources` table at call time (keyed by SkillContext.orgId). The
 * platform sets the GitHub App credentials (GITHUB_APP_ID +
 * GITHUB_APP_PRIVATE_KEY_BASE64) once; customers connect repos on the
 * Sources page and set no env vars. When the App credentials are
 * present the live skills register (and github_count is the live
 * Search-API variant); when absent they're skipped and github_count
 * falls back to the indexed corpus.
 *
 * The registry is a process-singleton; skills are stateless and resolve
 * per-org access per call.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SkillRegistry } from '@risezome/engine/skills';
import { GithubClient } from './github/client.js';
import { buildGithubAppAuth } from './github/app-auth.js';
import { buildGithubSourceResolver } from './github/source-resolver.js';
import type { LiveSkillContext } from './github/live-context.js';
import { buildIssueAssigneesSkill } from './github/issue_assignees.js';
import { buildByAssigneeCountSkill } from './github/by_assignee_count.js';
import { buildByAssigneeListSkill } from './github/by_assignee_list.js';
import { buildIssueProgressSkill } from './github/issue_progress.js';
import { buildSearchCountSkill } from './github/search_count.js';
import { buildSearchListSkill } from './github/search_list.js';
import { buildSearchRecentlyUpdatedSkill } from './github/search_recently_updated.js';
import { buildSearchByAuthorSkill } from './github/search_by_author.js';
import { countSkill } from './github/count.js';
import { listSkill } from './github/list.js';
import { byAuthorSkill } from './github/by_author.js';
import { recentlyUpdatedSkill } from './github/recently_updated.js';
import { TrelloClient } from './trello/client.js';
import { buildTrelloSourceResolver } from './trello/source-resolver.js';
import type { TrelloLiveContext } from './trello/live-context.js';
import { buildTrelloCountSkill } from './trello/count.js';
import { buildTrelloListSkill } from './trello/list.js';
import { buildTrelloByMemberSkill } from './trello/by_member.js';
import { buildTrelloRecentlyActiveSkill } from './trello/recently_active.js';
import { buildTrelloBoardBreakdownSkill } from './trello/board_breakdown.js';

export interface BuildSkillRegistryOptions {
  readonly logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
  /** Service-role Supabase client — the source resolver reads the
   *  `sources` table to map orgId → installation + repos. */
  readonly db: SupabaseClient;
}

export function buildSkillRegistry(options: BuildSkillRegistryOptions): SkillRegistry {
  const registry = new SkillRegistry();

  // ── Live-API GitHub skills ──────────────────────────────────────
  // Gated on the platform GitHub App credentials. With them present the
  // skills resolve each org's installation token + repos at call time;
  // an org with no GitHub source connected gets a graceful "connect on
  // the Sources page" answer.
  const appAuth = buildGithubAppAuth();
  const githubLive = appAuth !== null;
  if (appAuth === null) {
    options.logger.info(
      {
        hasAppId: (process.env.GITHUB_APP_ID ?? '').length > 0,
        hasPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ?? '').length > 0,
      },
      'github.live.disabled',
    );
  } else {
    const resolve = buildGithubSourceResolver({ db: options.db, appAuth });
    const liveContext: LiveSkillContext = {
      client: new GithubClient({}),
      resolve,
    };
    // All GitHub query skills are the live Search-API variants when App
    // auth is present — fresh data over the indexed corpus. They claim the
    // canonical names (github_count/list/recently_updated/by_author) so the
    // corpus fallbacks below are skipped to avoid duplicate-name errors.
    registry.register(buildSearchCountSkill(liveContext));
    registry.register(buildSearchListSkill(liveContext));
    registry.register(buildSearchRecentlyUpdatedSkill(liveContext));
    registry.register(buildSearchByAuthorSkill(liveContext));
    registry.register(buildIssueAssigneesSkill(liveContext));
    registry.register(buildByAssigneeCountSkill(liveContext));
    registry.register(buildByAssigneeListSkill(liveContext));
    registry.register(buildIssueProgressSkill(liveContext));
    options.logger.info({}, 'github.live.enabled');
  }

  // ── Corpus GitHub skills (fallback only) ────────────────────────
  // Registered only when the GitHub App isn't configured, so an org with
  // an indexed corpus still gets answers without the live API. When live
  // is enabled the Search-API variants above own these names.
  if (!githubLive) {
    registry.register(countSkill);
    registry.register(listSkill);
    registry.register(recentlyUpdatedSkill);
    registry.register(byAuthorSkill);
  }

  // ── Live-API Trello skills ──────────────────────────────────────
  // Gated on the platform Power-Up API key (TRELLO_API_KEY). Purely
  // additive — Trello has no corpus skills today, so there's no name
  // collision and nothing to fall back from. The per-org read token +
  // connected boards resolve from `trello_connections` + `sources` at call
  // time; an org with no Trello board connected gets a graceful "connect on
  // the Sources page" answer.
  const trelloApiKey = process.env.TRELLO_API_KEY ?? '';
  if (trelloApiKey.length === 0) {
    options.logger.info({}, 'trello.live.disabled');
  } else {
    const trelloContext: TrelloLiveContext = {
      client: new TrelloClient({ apiKey: trelloApiKey }),
      resolve: buildTrelloSourceResolver({ db: options.db }),
    };
    registry.register(buildTrelloCountSkill(trelloContext));
    registry.register(buildTrelloListSkill(trelloContext));
    registry.register(buildTrelloByMemberSkill(trelloContext));
    registry.register(buildTrelloRecentlyActiveSkill(trelloContext));
    registry.register(buildTrelloBoardBreakdownSkill(trelloContext));
    options.logger.info({}, 'trello.live.enabled');
  }

  options.logger.info(
    { registeredSkills: registry.list().map((s) => s.name) },
    'skills.registry.built',
  );

  return registry;
}
