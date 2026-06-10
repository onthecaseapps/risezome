// Inngest function registry — the SINGLE source of truth. The /api/inngest
// route hands `allInngestFunctions` to serve(); a function that isn't in this
// array DOES NOT EXIST as far as Inngest is concerned (this file previously
// drifted from the route's hand-maintained list, and indexGithubIssuesFn was
// silently never registered — issues/PRs were absent from every corpus).
// Add new functions HERE, nowhere else.

import { indexRepoFn } from './index-repo';
import { indexGithubIssuesFn } from './index-github-issues';
import { indexTrelloFn } from './index-trello';
import { indexJiraFn } from './index-jira';
import { indexConfluenceFn } from './index-confluence';
import { syncCalendarFn, syncAllCalendarsCron } from './sync-calendar';
import { launchBotFn } from './launch-bot';
import { reapStaleMeetingsCron } from './reap-stale-meetings';
import { purgeRemovedSourcesCron } from './purge-removed-sources';
import { retentionSweepsCron } from './retention-sweeps';
import { generateMeetingRecapFn } from './generate-meeting-recap';
import { assembleKnowledgeGapsFn } from './assemble-knowledge-gaps';
import { backfillKnowledgeGapsFn } from './backfill-knowledge-gaps';
import { provisionOrgKeyFn } from './provision-org-key';
import { migrateEncryptionToKmsFn } from './migrate-encryption-to-kms';
import { rotateOrgKeyFn } from './rotate-org-key';

export const allInngestFunctions = [
  indexRepoFn,
  indexGithubIssuesFn,
  indexTrelloFn,
  indexJiraFn,
  indexConfluenceFn,
  syncCalendarFn,
  syncAllCalendarsCron,
  launchBotFn,
  reapStaleMeetingsCron,
  purgeRemovedSourcesCron,
  retentionSweepsCron,
  generateMeetingRecapFn,
  assembleKnowledgeGapsFn,
  backfillKnowledgeGapsFn,
  provisionOrgKeyFn,
  migrateEncryptionToKmsFn,
  rotateOrgKeyFn,
];
