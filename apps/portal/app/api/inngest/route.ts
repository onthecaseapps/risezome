import { serve } from 'inngest/next';
import { inngest } from '../../../src/inngest/client';
import { indexRepoFn } from '../../../src/inngest/functions/index-repo';
import { indexTrelloFn } from '../../../src/inngest/functions/index-trello';
import { indexJiraFn } from '../../../src/inngest/functions/index-jira';
import { indexConfluenceFn } from '../../../src/inngest/functions/index-confluence';
import { syncCalendarFn, syncAllCalendarsCron } from '../../../src/inngest/functions/sync-calendar';
import { launchBotFn } from '../../../src/inngest/functions/launch-bot';
import { reapStaleMeetingsCron } from '../../../src/inngest/functions/reap-stale-meetings';

/**
 * Inngest function registry, exposed at /api/inngest.
 *
 * - GET  → introspection (the dev CLI uses this to discover functions)
 * - POST → function invocation (Inngest's dispatcher calls this with the event)
 * - PUT  → sync request (deploy-time registration)
 *
 * Production uses INNGEST_SIGNING_KEY (set by the Vercel-Inngest integration)
 * to verify inbound requests; local dev with the Inngest dev CLI runs
 * unsigned. The `serve()` helper handles both.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    indexRepoFn,
    indexTrelloFn,
    indexJiraFn,
    indexConfluenceFn,
    syncCalendarFn,
    syncAllCalendarsCron,
    launchBotFn,
    reapStaleMeetingsCron,
  ],
});
