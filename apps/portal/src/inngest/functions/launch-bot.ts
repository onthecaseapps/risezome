import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { launchRecallBot } from '../../../app/_lib/recall-bot-launcher';
import { signBotWsJwt } from '../../../app/_lib/bot-ws-jwt';
import { normalizeConferenceUrl } from '../../../app/_lib/conference-url';

/** Meeting statuses that count as a live bot already serving the meeting. */
const LIVE_STATUSES = ['launching', 'awaiting_recall', 'joining', 'waiting_room', 'recording'];

/**
 * Scheduled launcher: fires a Recall.ai bot just before a meeting starts.
 *
 * Trigger: `risezome/bot.scheduled-launch` is emitted by the opt-in
 * toggle (U8c) when a user flips bot_optin → true, and by the
 * calendar-sync function when a rescheduled event's bot_optin is
 * already true.
 *
 * Lifecycle:
 *   1. sleepUntil(scheduledStartAt - 90s) — Recall cold-start margin.
 *   2. Re-fetch the calendar_event. If:
 *        - row is missing → exit (event was deleted)
 *        - bot_optin === false → exit (user toggled off after scheduling)
 *        - start_at !== scheduledStartAt → exit (event was rescheduled;
 *          a fresh scheduled-launch event covers the new time)
 *   3. Insert a meetings row with status='launching'.
 *      - Partial unique index on calendar_event_id WHERE status != 'failed'
 *        prevents a race where two scheduled launches arrive together.
 *        On conflict (duplicate active row), exit — the other run owns it.
 *   4. Look up the user's display name for the bot's join-chat message.
 *   5. Call launchRecallBot. On success: meetings.status = 'awaiting_recall'
 *      + recall_bot_id. On failure: meetings.status = 'failed' + error_code
 *      + error_message.
 *
 * Concurrency: 1 per calendar_event_id at the Inngest layer too —
 * cheaper than letting both runs reach the DB and one fail the unique
 * index.
 *
 * Retry posture: launcher throws on 5xx / network → Inngest retries
 * with backoff. 4xx returns a discriminated-union failure → we persist
 * 'failed' status and DO NOT retry (Inngest sees a successful run).
 */
export const launchBotFn = inngest.createFunction(
  {
    id: 'launch-bot',
    name: 'Launch Recall.ai bot for scheduled meeting',
    concurrency: [{ key: 'event.data.calendarEventId', limit: 1 }],
    retries: 3,
    triggers: [{ event: 'risezome/bot.scheduled-launch' }],
  },
  async ({ event, step }) => {
    const { calendarEventId, scheduledStartAt } = (event as unknown as {
      data: { calendarEventId: string; scheduledStartAt: string };
    }).data;

    // ── Step 1: sleep until 90s before start (if there's time to wait) ──
    const launchAt = new Date(new Date(scheduledStartAt).getTime() - 90 * 1000);
    // Inngest's sleepUntil is supposed to be a no-op for past targets,
    // but in practice the function can hang or get stuck queued. Skip
    // the sleep step entirely when we're already inside the launch
    // window — the user just toggled bot-on for a meeting starting
    // very soon (or already in progress), and they want the bot NOW,
    // not after some queue delay.
    if (launchAt > new Date()) {
      await step.sleepUntil('wait-until-launch-window', launchAt);
    }

    // ── Step 2: re-fetch + validate ──────────────────────────────────
    const check = await step.run('reload-event', async () => {
      const service = createServiceRoleClient();
      // service-role-cross-org: launch job's only input is the calendarEventId from
      // the trusted event payload; this lookup RESOLVES org_id (it is the output).
      const { data, error } = await service
        .from('calendar_events')
        .select('id, user_id, org_id, bot_optin, start_at, conference_url, title, platform')
        .eq('id', calendarEventId)
        .maybeSingle();
      if (error !== null) {
        throw new Error(`reload-event failed: ${error.message}`);
      }
      if (data === null) {
        return { exit: 'event_deleted' as const };
      }
      if (data.bot_optin !== true) {
        return { exit: 'toggled_off' as const };
      }
      if (data.start_at !== scheduledStartAt) {
        // The event was rescheduled. A fresh scheduled-launch event
        // will fire for the new time; this stale run exits.
        return { exit: 'rescheduled' as const };
      }
      if (data.platform !== 'zoom' && data.platform !== 'meet') {
        // Belt-and-suspenders: the toggle action gates this too, but
        // an admin SQL flip could land us here.
        return { exit: 'unsupported_platform' as const };
      }
      if (typeof data.conference_url !== 'string' || data.conference_url.length === 0) {
        return { exit: 'no_conference_url' as const };
      }
      return {
        exit: null,
        event: {
          id: data.id as string,
          user_id: data.user_id as string,
          org_id: data.org_id as string,
          start_at: data.start_at as string,
          conference_url: data.conference_url,
          title: (data.title as string) ?? '',
        },
      };
    });

    if (check.exit !== null) {
      return { skipped: check.exit, calendarEventId };
    }
    const eventRow = check.event;
    const conferenceUrl = normalizeConferenceUrl(eventRow.conference_url);

    // ── Step 3: resolve-or-create the meeting ────────────────────────
    // One bot per meeting (R12/R13): look up a live meeting for this
    // conference URL in the org. If one exists, this attendee joins it (no
    // second bot). Otherwise create it. The (org_id, conference_url) live
    // unique index is the race backstop — a launch that loses the insert race
    // resolves to the winner and joins it.
    const meetingRow = await step.run('resolve-or-create-meeting', async () => {
      const service = createServiceRoleClient();

      const existing = await service
        .from('meetings')
        .select('meeting_id')
        .eq('org_id', eventRow.org_id)
        .eq('conference_url', conferenceUrl)
        .in('status', LIVE_STATUSES)
        .limit(1)
        .maybeSingle();
      if (existing.error !== null) {
        throw new Error(`find-meeting failed: ${existing.error.message}`);
      }
      if (existing.data !== null) {
        return { meetingId: existing.data.meeting_id as string, created: false };
      }

      const inserted = await service
        .from('meetings')
        .insert({
          org_id: eventRow.org_id,
          user_id: eventRow.user_id,
          calendar_event_id: eventRow.id,
          conference_url: conferenceUrl,
          title: eventRow.title,
          status: 'launching',
        })
        .select('meeting_id')
        .single();
      if (inserted.error !== null) {
        // 23505 = unique_violation — another launch created the live meeting
        // first (or the same calendar event already has a live meeting).
        // Resolve to the winner and join it instead of launching a 2nd bot.
        if (inserted.error.code === '23505') {
          const winner = await service
            .from('meetings')
            .select('meeting_id')
            .eq('org_id', eventRow.org_id)
            .eq('conference_url', conferenceUrl)
            .in('status', LIVE_STATUSES)
            .limit(1)
            .maybeSingle();
          if (winner.error !== null || winner.data === null) {
            throw new Error(
              `resolve-after-conflict failed: ${winner.error?.message ?? 'no winner row'}`,
            );
          }
          return { meetingId: winner.data.meeting_id as string, created: false };
        }
        throw new Error(`insert-meeting failed: ${inserted.error.message}`);
      }
      return { meetingId: inserted.data.meeting_id as string, created: true };
    });

    const meetingId = meetingRow.meetingId;

    // ── Step 3b: associate participants ──────────────────────────────
    // Always associate the requester. On create, also sweep every org
    // attendee whose calendar event carries this conference URL, so a
    // non-launcher attendee can see the capture (R13/R14).
    await step.run('associate-participants', async () => {
      const service = createServiceRoleClient();
      const userIds = new Set<string>([eventRow.user_id]);
      if (meetingRow.created) {
        const attendees = await service
          .from('calendar_events')
          .select('user_id, conference_url')
          .eq('org_id', eventRow.org_id);
        for (const row of attendees.data ?? []) {
          const cu = row.conference_url as string | null;
          if (cu !== null && normalizeConferenceUrl(cu) === conferenceUrl) {
            userIds.add(row.user_id as string);
          }
        }
      }
      const rows = [...userIds].map((uid) => ({ meeting_id: meetingId, user_id: uid }));
      await service
        .from('meeting_participants')
        .upsert(rows, { onConflict: 'meeting_id,user_id', ignoreDuplicates: true });
    });

    // Joined an existing live meeting — a bot is already serving it.
    if (!meetingRow.created) {
      return { skipped: 'joined_existing_meeting', calendarEventId, meetingId };
    }

    // ── Step 4: lookup user name for join-chat ───────────────────────
    const userName = await step.run('lookup-user-name', async () => {
      const service = createServiceRoleClient();
      const { data } = await service.auth.admin.getUserById(eventRow.user_id);
      const user = data?.user;
      // Order of preference: full_name → name → email local part → 'a Risezome user'
      const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
      const fullName = typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : null;
      const name = typeof meta['name'] === 'string' ? (meta['name'] as string) : null;
      const email = user?.email ?? null;
      const emailLocal = email !== null ? email.split('@')[0] : null;
      return fullName ?? name ?? emailLocal ?? 'a Risezome user';
    });

    // ── Step 5: launch (or fail) ─────────────────────────────────────
    // Sign the bot-worker JWT BEFORE Create Bot — Recall bakes the
    // realtime_endpoints URL at create time and never lets us change
    // it, so we can't include the JWT after the fact. The verifier
    // (apps/bot-worker/src/jwt.ts) MUST stay in sync with this signer
    // (apps/portal/app/_lib/bot-ws-jwt.ts).
    const botWsJwt = await signBotWsJwt(
      { meetingId, orgId: eventRow.org_id },
      requireEnv('BOT_WORKER_SECRET'),
    );

    const launchResult = await step.run('create-bot', async () => {
      return await launchRecallBot(
        {
          meetingUrl: eventRow.conference_url,
          meetingId,
          orgId: eventRow.org_id,
          userId: eventRow.user_id,
          userName,
          botWsJwt,
        },
        {
          apiKey: requireEnv('RECALL_API_KEY'),
          deepgramKey: requireEnv('RECALL_DEEPGRAM_KEY'),
          botWorkerBaseUrl: requireEnv('BOT_WORKER_BASE_URL'),
          region: process.env['RECALL_REGION'] ?? 'us-east-1',
          // Safety cap on bot duration so a runaway bug can't leave a
          // bot in indefinitely. Default 300s (5 min) is enforced in
          // the launcher itself; this env override lifts it for prod.
          maxCallDurationSeconds: parseDurationEnv(
            process.env['RECALL_MAX_DURATION_SECONDS'],
            300,
          ),
          // Local-dev isolation: tag bots with the developer so a shared Recall
          // Environment could demux by owner. Unset in prod / with per-dev
          // Environments (the primary isolation path).
          ...(process.env['RECALL_DEVELOPER_ID']
            ? { developerId: process.env['RECALL_DEVELOPER_ID'] }
            : {}),
        },
      );
    });

    await step.run('finalize-meeting-row', async () => {
      const service = createServiceRoleClient();
      if (launchResult.success) {
        await service
          .from('meetings')
          .update({
            status: 'awaiting_recall',
            recall_bot_id: launchResult.recallBotId,
          })
          .eq('meeting_id', meetingId)
          .eq('org_id', eventRow.org_id); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      } else {
        await service
          .from('meetings')
          .update({
            status: 'failed',
            error_code: launchResult.errorCode,
            error_message: launchResult.errorMessage,
          })
          .eq('meeting_id', meetingId)
          .eq('org_id', eventRow.org_id); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      }
    });

    return {
      calendarEventId,
      meetingId,
      ...(launchResult.success
        ? { recallBotId: launchResult.recallBotId, status: 'awaiting_recall' as const }
        : { status: 'failed' as const, errorCode: launchResult.errorCode }),
    };
  },
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseDurationEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
