import { Inngest } from 'inngest';

/**
 * Event vocabulary. All event names are namespaced under `risezome/...` so
 * the cloud dashboard's event browser is easy to scan.
 *
 * Conventions:
 *   - Past-tense names for things that already happened (e.g. `source.created`).
 *   - Imperative names for explicit user-or-system requests
 *     (e.g. `source.index-requested`).
 *   - Payload always includes `orgId` so the function can scope DB writes
 *     and the dashboard can filter per-org.
 */
export interface SourceIndexRequestedEvent {
  name: 'risezome/source.index-requested';
  data: {
    orgId: string;
    sourceId: string;
    reason: 'install' | 'reindex' | 'webhook';
  };
}

/**
 * Trello-specific index request. Separate from `source.index-requested` (which
 * the GitHub indexer triggers on) so the two indexers never both fire for one
 * source — the Sources actions emit by `source.kind`.
 */
export interface TrelloIndexRequestedEvent {
  name: 'risezome/trello.index-requested';
  data: {
    orgId: string;
    sourceId: string;
    reason: 'connect' | 'reindex';
  };
}

/** Atlassian per-kind index requests (own events so each indexer triggers only
 *  for its kind; the Sources actions emit by source.kind). */
export interface JiraIndexRequestedEvent {
  name: 'risezome/jira.index-requested';
  data: { orgId: string; sourceId: string; reason: 'connect' | 'reindex' };
}
export interface ConfluenceIndexRequestedEvent {
  name: 'risezome/confluence.index-requested';
  data: { orgId: string; sourceId: string; reason: 'connect' | 'reindex' };
}

export interface CalendarSyncRequestedEvent {
  name: 'risezome/calendar.sync-requested';
  data: {
    userId: string;
    orgId: string;
    reason: 'sign-in' | 'cron' | 'manual';
  };
}

export interface BotScheduledLaunchEvent {
  name: 'risezome/bot.scheduled-launch';
  data: {
    calendarEventId: string;
    /** ISO 8601. The launcher sleeps until start_at - 90s and verifies
     *  the row's start_at still matches before launching. */
    scheduledStartAt: string;
  };
}

/**
 * The Inngest client is a singleton per process. Production uses the
 * INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY env vars set by the Vercel-Inngest
 * integration. Local dev uses the Inngest dev CLI which discovers functions
 * at http://localhost:3000/api/inngest and needs no event key — but the
 * SDK's auto-detection of dev mode is unreliable (it defaults to "cloud"
 * unless we explicitly opt in). We flip `isDev` on whenever NODE_ENV is
 * not 'production' so leaving the keys unset in .env.local is the correct
 * dev posture.
 */
export const inngest = new Inngest({
  id: 'risezome-portal',
  isDev: process.env['NODE_ENV'] !== 'production',
});
