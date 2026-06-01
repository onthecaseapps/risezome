import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';

/**
 * Reaper for stuck meetings (#29).
 *
 * The canonical path to `completed` is the Recall `bot.call_ended` webhook.
 * When that webhook never arrives (cloudflared tunnel down at meeting end,
 * Svix drop, bot crash) the meeting stays `recording` forever and shows up
 * on the Live page with an ever-growing duration.
 *
 * Authoritative cutoff: Recall's `automatic_leave` caps the bot at
 * `RECALL_MAX_DURATION_SECONDS` (the launcher passes it as
 * in_call_recording_timeout / in_call_not_recording_timeout), so the bot is
 * *physically gone* by `started_at + maxDuration`. Anything still `recording`
 * past `started_at + maxDuration + buffer` is a missed webhook, not a live
 * meeting — safe to complete. We mirror the launcher's 300s fallback so dev
 * and prod agree, and clamp to a hard backstop so a misconfigured env can't
 * push the cutoff out indefinitely.
 *
 * Pre-recording states (launching/awaiting_recall/joining/waiting_room) that
 * never reach `recording` within a grace window are failed — the bot was
 * never admitted, or its failure webhook was also dropped.
 *
 * Idempotent: every write is guarded by the source status, so a second pass
 * (or a late webhook) is a no-op. Uses the service-role client (RLS bypass)
 * and runs as a 10-minute cron.
 */

/** Mirrors the launcher's RECALL_MAX_DURATION_SECONDS fallback. */
const DEFAULT_MAX_DURATION_S = 300;
/** Slack for webhook-delivery lag before we declare a recording dead. */
const REAP_BUFFER_S = 15 * 60;
/** Absolute backstop so a huge/misconfigured max-duration can't disable reaping. */
const HARD_CAP_S = 12 * 60 * 60;
/** Pre-recording states should reach `recording` well within this window. */
const PRELAUNCH_GRACE_S = 20 * 60;

const PRE_RECORDING_STATUSES = ['launching', 'awaiting_recall', 'joining', 'waiting_room'] as const;

function maxDurationSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env['RECALL_MAX_DURATION_SECONDS'];
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_DURATION_S;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DURATION_S;
  return parsed;
}

/**
 * How long after a recording's start we wait before treating it as a missed
 * `bot.call_ended`. = max bot duration + buffer, clamped to the hard cap.
 */
export function recordingReapAfterMs(env: Record<string, string | undefined> = process.env): number {
  const candidate = (maxDurationSeconds(env) + REAP_BUFFER_S) * 1000;
  return Math.min(candidate, HARD_CAP_S * 1000);
}

interface ReaperRows {
  data: { meeting_id: string }[] | null;
  error: { message: string } | null;
}

/** Postgrest-like filter chain after `.update(...).eq()/.in()`. */
interface ReaperFilterChain {
  not(col: string, op: string, value: unknown): ReaperFilterChain;
  is(col: string, value: unknown): ReaperFilterChain;
  lt(col: string, value: unknown): ReaperFilterChain;
  select(cols: string): Promise<ReaperRows>;
}

/** Minimal structural view of the Supabase client the reaper needs. */
export interface ReaperDb {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(col: string, value: unknown): ReaperFilterChain;
      in(col: string, values: readonly string[]): ReaperFilterChain;
    };
  };
}

export interface ReapResult {
  completed: number;
  failedPrelaunch: number;
}

/**
 * Core reaper logic, separated from the Inngest wrapper so it's directly
 * testable. `notify` is best-effort and awaited in parallel.
 */
export async function reapStaleMeetings(
  service: ReaperDb,
  opts: { nowMs: number; recordingReapAfterMs: number; notify: (meetingId: string) => Promise<void> },
): Promise<ReapResult> {
  const recordingCutoff = new Date(opts.nowMs - opts.recordingReapAfterMs).toISOString();
  const prelaunchCutoff = new Date(opts.nowMs - PRELAUNCH_GRACE_S * 1000).toISOString();
  const completedAt = new Date(opts.nowMs).toISOString();

  const reapedIds: string[] = [];

  // 1. Recording meetings whose bot is guaranteed gone (started_at known).
  const byStart = await service
    .from('meetings')
    .update({ status: 'completed', ended_at: completedAt })
    .eq('status', 'recording')
    .not('started_at', 'is', null)
    .lt('started_at', recordingCutoff)
    .select('meeting_id');
  if (byStart.error !== null) throw new Error(`reap recording (started_at): ${byStart.error.message}`);
  for (const row of byStart.data ?? []) reapedIds.push(row.meeting_id);

  // 2. Recording meetings the webhook flipped before any utterance set
  //    started_at — fall back to created_at for the cutoff.
  const byCreated = await service
    .from('meetings')
    .update({ status: 'completed', ended_at: completedAt })
    .eq('status', 'recording')
    .is('started_at', null)
    .lt('created_at', recordingCutoff)
    .select('meeting_id');
  if (byCreated.error !== null) throw new Error(`reap recording (created_at): ${byCreated.error.message}`);
  for (const row of byCreated.data ?? []) reapedIds.push(row.meeting_id);

  // 3. Pre-recording states that never started recording in time → failed.
  const prelaunch = await service
    .from('meetings')
    .update({
      status: 'failed',
      error_code: 'launch_timeout',
      error_message:
        'The bot never started recording. It may not have been admitted to the meeting, or the meeting did not start.',
    })
    .in('status', PRE_RECORDING_STATUSES as unknown as string[])
    .lt('created_at', prelaunchCutoff)
    .select('meeting_id');
  if (prelaunch.error !== null) throw new Error(`reap pre-recording: ${prelaunch.error.message}`);

  // Best-effort: drop the bot-worker's in-memory runtime for each reaped
  // recording. The DB row is already the source of truth.
  await Promise.all(reapedIds.map((id) => opts.notify(id)));

  return { completed: reapedIds.length, failedPrelaunch: (prelaunch.data ?? []).length };
}

async function notifyBotWorker(meetingId: string): Promise<void> {
  const base = process.env['BOT_WORKER_HTTP_URL'];
  if (base === undefined || base.length === 0) return;
  try {
    await fetch(`${base.replace(/\/$/, '')}/meetings/${encodeURIComponent(meetingId)}/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch {
    /* swallow — DB row is already the source of truth */
  }
}

export const reapStaleMeetingsCron = inngest.createFunction(
  {
    id: 'reap-stale-meetings-cron',
    name: 'Reap stuck meetings (10 min)',
    retries: 1,
    triggers: [{ cron: '*/10 * * * *' }],
  },
  async () => {
    const service = createServiceRoleClient() as unknown as ReaperDb;
    return reapStaleMeetings(service, {
      nowMs: Date.now(),
      recordingReapAfterMs: recordingReapAfterMs(),
      notify: notifyBotWorker,
    });
  },
);
