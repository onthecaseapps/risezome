import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import {
  getGoogleAccessToken,
  GoogleTokenMissingError,
  GoogleTokenRefreshError,
} from '../../../app/_lib/google-token';
import {
  extractConference,
  type GoogleEventShape,
} from '../../../app/_lib/conference-extract';

/**
 * Pull a single user's calendar events for the next 7 days from Google's
 * primary calendar and upsert them into `calendar_events`.
 *
 * Steps:
 *   1. Get a fresh Google access token (refresh if needed via google-token).
 *   2. Page through `GET /calendar/v3/calendars/primary/events` with
 *      `singleEvents=true&orderBy=startTime` so recurring events expand
 *      into individual occurrences.
 *   3. For each event:
 *      - Skip if it has no start.dateTime (all-day events — Risezome bots
 *        only attach to time-bounded meetings).
 *      - Skip if the event is cancelled.
 *      - Extract conference URL + platform via conference-extract.
 *      - Upsert on (user_id, event_id). bot_optin is preserved because
 *        the upsert payload does not include it.
 *   4. Return a small summary; Inngest renders it in the run trace.
 *
 * Failure shape:
 *   - GoogleTokenMissing → permanent (no point retrying). The user
 *     hasn't connected Google yet (or revoked); we log and return a
 *     success-shaped result so Inngest doesn't burn retries.
 *   - GoogleTokenRefresh → permanent for the same reason; refresh
 *     token rejected.
 *   - Anything else → let Inngest retry with backoff.
 *
 * Scheduled fan-out: see `syncAllCalendarsCron` below for the
 * every-5-minute cron that emits one sync event per user with stored
 * Google tokens.
 */

const EVENTS_API_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const WINDOW_DAYS = 7;
const PAGE_SIZE = 250;

interface SyncEventData {
  data: {
    userId: string;
    orgId: string;
    reason: 'sign-in' | 'cron' | 'manual';
  };
}

interface GoogleListResponse {
  items?: Array<Record<string, unknown>>;
  nextPageToken?: string;
}

export const syncCalendarFn = inngest.createFunction(
  {
    id: 'sync-calendar',
    name: 'Sync a user calendar',
    // One sync per user at a time — the per-event upsert is idempotent
    // but we don't need to double-pay the Google quota for parallel runs.
    concurrency: [{ key: 'event.data.userId', limit: 1 }],
    retries: 2,
    triggers: [{ event: 'risezome/calendar.sync-requested' }],
  },
  async ({ event, step }) => {
    const { userId, orgId } = (event as unknown as SyncEventData).data;

    // ── Step 1: access token ─────────────────────────────────────────
    let accessToken: string;
    try {
      accessToken = await step.run('get-access-token', async () => {
        return await getGoogleAccessToken(userId);
      });
    } catch (err) {
      if (err instanceof GoogleTokenMissingError || err instanceof GoogleTokenRefreshError) {
        // eslint-disable-next-line no-console
        console.warn(`[sync-calendar] user=${userId} ${err.name}: ${err.message}`);
        return { userId, skipped: true, reason: err.name };
      }
      throw err;
    }

    // ── Step 2: paged events.list ────────────────────────────────────
    const events = await step.run('list-events', async () => {
      const now = new Date();
      const horizon = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: horizon.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(PAGE_SIZE),
      });

      const collected: Array<Record<string, unknown>> = [];
      let pageToken: string | undefined;
      // Cap pages defensively — 7 days × 250 events should never need
      // more than a handful of pages, but bail out if Google starts
      // returning unexpectedly large pagination chains.
      for (let i = 0; i < 10; i += 1) {
        const url = new URL(EVENTS_API_BASE);
        url.search = params.toString();
        if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);

        const resp = await fetch(url, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`events.list ${resp.status}: ${body.slice(0, 200)}`);
        }
        const json = (await resp.json()) as GoogleListResponse;
        if (Array.isArray(json.items)) collected.push(...json.items);
        if (json.nextPageToken === undefined) break;
        pageToken = json.nextPageToken;
      }
      return collected;
    });

    // ── Step 3: upsert ───────────────────────────────────────────────
    const result = await step.run('upsert-events', async () => {
      const service = createServiceRoleClient();
      const rows = events
        .map((ev) => normalizeForUpsert(ev, userId, orgId))
        .filter((r): r is CalendarEventRow => r !== null);

      if (rows.length === 0) return { upserted: 0, skipped: events.length };

      // bot_optin is intentionally NOT in the upsert payload so existing
      // values are preserved. Conflict resolution: (user_id, event_id).
      const { error } = await service
        .from('calendar_events')
        .upsert(rows, { onConflict: 'user_id,event_id' });
      if (error !== null) {
        throw new Error(`upsert failed: ${error.message}`);
      }

      return { upserted: rows.length, skipped: events.length - rows.length };
    });

    return { userId, orgId, ...result };
  },
);

/**
 * Scheduled fan-out: every 5 minutes, find every user with a stored
 * refresh token and emit a sync-requested event for them. This is the
 * dev-time substitute for Google's push notifications (deferred until
 * the risezome.app domain is verified in Google Cloud Console).
 *
 * Scoping note: a user can be in multiple orgs. For each user we pick
 * the *first* org by joined_at — pragmatic for the single-org beta;
 * U-later can split events by org-membership if multi-org rendering
 * matters.
 */
export const syncAllCalendarsCron = inngest.createFunction(
  {
    id: 'sync-calendar-cron',
    name: 'Sync all user calendars (5 min)',
    retries: 1,
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    const work = await step.run('list-users', async () => {
      const service = createServiceRoleClient();
      // Two-step lookup so we don't depend on a Postgres view: pull every
      // token row, then per token resolve the user's primary org.
      const { data: tokens, error: tokenErr } = await service
        .from('user_google_tokens')
        .select('user_id');
      if (tokenErr !== null) throw new Error(`list tokens: ${tokenErr.message}`);

      const out: Array<{ userId: string; orgId: string }> = [];
      for (const t of tokens ?? []) {
        const userId = t.user_id as string;
        const { data: membership } = await service
          .from('org_members')
          .select('org_id, joined_at')
          .eq('user_id', userId)
          .order('joined_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (membership !== null) {
          out.push({ userId, orgId: membership.org_id as string });
        }
      }
      return out;
    });

    if (work.length === 0) return { dispatched: 0 };

    await step.run('fan-out', async () => {
      await inngest.send(
        work.map((w) => ({
          name: 'risezome/calendar.sync-requested' as const,
          data: { userId: w.userId, orgId: w.orgId, reason: 'cron' as const },
        })),
      );
    });

    return { dispatched: work.length };
  },
);

// ── Helpers ────────────────────────────────────────────────────────

interface CalendarEventRow {
  user_id: string;
  org_id: string;
  event_id: string;
  ical_uid: string | null;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  conference_url: string | null;
  platform: 'zoom' | 'meet' | 'other' | null;
  attendee_count: number;
  is_organizer: boolean;
  raw: Record<string, unknown>;
}

function normalizeForUpsert(
  ev: Record<string, unknown>,
  userId: string,
  orgId: string,
): CalendarEventRow | null {
  if (ev['status'] === 'cancelled') return null;

  const id = ev['id'];
  if (typeof id !== 'string' || id.length === 0) return null;

  const start = ev['start'] as { dateTime?: string; date?: string } | undefined;
  const end = ev['end'] as { dateTime?: string; date?: string } | undefined;
  // Skip all-day events (no time-bounded meeting → bot can't join).
  if (start?.dateTime === undefined || end?.dateTime === undefined) return null;

  const conference = extractConference(ev as GoogleEventShape);

  const attendees = Array.isArray(ev['attendees']) ? (ev['attendees'] as unknown[]) : [];
  const isOrganizer = ((ev['organizer'] as { self?: boolean } | undefined)?.self) === true;

  // Store only fields useful for debugging — the full event would bloat
  // the JSONB. We keep status, attendees count, and source/origin hints.
  const rawSlice: Record<string, unknown> = {
    status: ev['status'],
    htmlLink: ev['htmlLink'],
    organizer: ev['organizer'],
  };

  return {
    user_id: userId,
    org_id: orgId,
    event_id: id,
    ical_uid: typeof ev['iCalUID'] === 'string' ? (ev['iCalUID'] as string) : null,
    title: typeof ev['summary'] === 'string' ? (ev['summary'] as string) : '',
    description: typeof ev['description'] === 'string' ? (ev['description'] as string) : null,
    start_at: start.dateTime,
    end_at: end.dateTime,
    conference_url: conference.url,
    platform: conference.platform,
    attendee_count: attendees.length,
    is_organizer: isOrganizer,
    raw: rawSlice,
  };
}
