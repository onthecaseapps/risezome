/**
 * Recall.ai Create Bot wrapper with zero-data-retention (ZDR) fail-closed
 * enforcement. R11b is the trust-story keystone: every bot Risezome
 * creates MUST run with `recording_config.retention === null` so Recall
 * never stores transcripts/recordings server-side, AND with
 * `transcript.provider.deepgram_streaming.mode === 'prioritize_low_latency'`
 * so the live-card pipeline gets utterances fast enough.
 *
 * Two layers of defense:
 *   1. The body builder writes both values directly into the payload.
 *   2. An assertion runs IMMEDIATELY BEFORE fetch() and throws
 *      ZdrEnforcementError if either drifted. The fetch never happens
 *      if the assertion fails — fail-closed. A regression test
 *      exercises this by mutating the body via __mutateBodyForTest.
 *
 * Caller pattern: the Inngest launch-bot function wraps this in
 * step.run('create-bot', ...) so retries are idempotent on the Inngest
 * side. The launcher itself does no retry — that's Inngest's job for
 * 5xx, and a permanent failure (4xx) shouldn't retry anyway.
 *
 * Return shape: discriminated union so the caller can route on
 * success vs failure without exception handling for expected failure
 * modes (invalid URL is a real outcome, not an exception).
 */

const RECALL_BOT_PATH = '/api/v1/bot/';
const BOT_NAME = 'Risezome';

export interface LaunchBotArgs {
  meetingUrl: string;
  /** Our platform-internal UUID for the meeting row. */
  meetingId: string;
  orgId: string;
  userId: string;
  /** Display name to mention in the bot's join-chat message. */
  userName: string;
  /** Signed JWT for the bot-worker WS upgrade. Appended to the
   *  realtime_endpoints URL as a path segment. */
  botWsJwt: string;
}

export interface LaunchBotDeps {
  apiKey: string;
  deepgramKey: string;
  /** wss URL the bot streams transcripts to. e.g. wss://bot-worker.risezome.app */
  botWorkerBaseUrl: string;
  /** Recall.ai region. Defaults to 'us-east-1'. */
  region?: string;
  /**
   * Hard cap on how long the bot stays in the meeting, in seconds.
   * Applied to BOTH `in_call_recording_timeout` and
   * `in_call_not_recording_timeout` so the bot leaves regardless of
   * whether it's actively recording. Default: 300 (5 min) — safe
   * for dev/test so a runaway bug can't leave a bot in indefinitely.
   * Lift via env var (e.g. 3600 for production once the surface is
   * proven). Must be > 0; treated as integer seconds.
   */
  maxCallDurationSeconds?: number;
  /** Override for testing. */
  fetch?: typeof fetch;
  /**
   * Test-only escape hatch to mutate the request body just before the
   * ZDR assertion runs. Used by the regression test to prove the
   * assertion is the load-bearing guard.
   */
  __mutateBodyForTest?: (body: RecallBotRequestBody) => void;
}

export type LaunchBotResult =
  | { success: true; recallBotId: string }
  | { success: false; errorCode: string; errorMessage: string };

export class ZdrEnforcementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZdrEnforcementError';
  }
}

interface RecallBotRequestBody {
  meeting_url: string;
  bot_name: string;
  recording_config: {
    retention: null;
    transcript: {
      provider: {
        deepgram_streaming: {
          api_key: string;
          model: string;
          mode: string;
        };
      };
    };
    realtime_endpoints: Array<{
      type: 'websocket';
      url: string;
      events: string[];
    }>;
  };
  chat: {
    on_bot_join: {
      send_to: 'everyone';
      message: string;
    };
  };
  automatic_leave: {
    waiting_room_timeout: number;
    noone_joined_timeout: number;
    everyone_left_timeout: number;
    in_call_recording_timeout: number;
    in_call_not_recording_timeout: number;
  };
  metadata: {
    org_id: string;
    meeting_id: string;
    user_id: string;
  };
}

export async function launchRecallBot(
  args: LaunchBotArgs,
  deps: LaunchBotDeps,
): Promise<LaunchBotResult> {
  const region = deps.region ?? 'us-east-1';
  const url = `https://${region}.recall.ai${RECALL_BOT_PATH}`;

  const body: RecallBotRequestBody = buildBody(args, deps);

  if (deps.__mutateBodyForTest !== undefined) {
    deps.__mutateBodyForTest(body);
  }

  // ── ZDR enforcement (R11b): fail closed BEFORE the network call ──
  assertZdrEnforcement(body);

  const doFetch = deps.fetch ?? globalThis.fetch;
  let resp: Response;
  try {
    resp = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Token ${deps.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network / DNS / abort errors. Re-throw so Inngest retries.
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (resp.status >= 500) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Recall ${resp.status}: ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    return classifyFailure(resp);
  }

  let parsed: { id?: string };
  try {
    parsed = (await resp.json()) as { id?: string };
  } catch {
    throw new Error('Recall 2xx returned non-JSON body');
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('Recall 2xx returned no bot id');
  }
  return { success: true, recallBotId: parsed.id };
}

function buildBody(args: LaunchBotArgs, deps: LaunchBotDeps): RecallBotRequestBody {
  return {
    meeting_url: args.meetingUrl,
    bot_name: BOT_NAME,
    recording_config: {
      // R11b: ZERO-DATA-RETENTION on Recall.ai's side. Do not
      // change this without revisiting the consent posture in
      // docs/plans/.../#scope-boundaries.
      retention: null,
      transcript: {
        provider: {
          deepgram_streaming: {
            api_key: deps.deepgramKey,
            model: 'nova-3',
            mode: 'prioritize_low_latency',
          },
        },
      },
      realtime_endpoints: [
        {
          type: 'websocket',
          url: `${stripTrailingSlash(deps.botWorkerBaseUrl)}/recall/${args.meetingId}/${args.botWsJwt}`,
          events: [
            'transcript.data',
            'transcript.partial_data',
            'participant_events.join',
            'participant_events.leave',
          ],
        },
      ],
    },
    chat: {
      on_bot_join: {
        send_to: 'everyone',
        message: `Risezome is taking notes for ${args.userName}. View live at risezome.app/meetings/${args.meetingId}/live`,
      },
    },
    automatic_leave: {
      waiting_room_timeout: 60 * 20,
      noone_joined_timeout: 60 * 10,
      everyone_left_timeout: 30,
      // Hard cap on total time in the meeting. Applied to both the
      // recording and non-recording timeouts so the bot leaves
      // unconditionally after this many seconds. Dev-safe default
      // = 300 (5 min); production lifts via env in the caller.
      // Throws if someone passes a non-positive value.
      in_call_recording_timeout: assertPositiveSeconds(
        deps.maxCallDurationSeconds ?? 300,
        'maxCallDurationSeconds',
      ),
      in_call_not_recording_timeout: assertPositiveSeconds(
        deps.maxCallDurationSeconds ?? 300,
        'maxCallDurationSeconds',
      ),
    },
    metadata: {
      org_id: args.orgId,
      meeting_id: args.meetingId,
      user_id: args.userId,
    },
  };
}

function assertZdrEnforcement(body: RecallBotRequestBody): void {
  if (body.recording_config?.retention !== null) {
    throw new ZdrEnforcementError(
      'recording_config.retention is not null — refusing to send bot to protect ZDR posture (R11b)',
    );
  }
  const mode = body.recording_config?.transcript?.provider?.deepgram_streaming?.mode;
  if (mode !== 'prioritize_low_latency') {
    throw new ZdrEnforcementError(
      `transcript.provider.deepgram_streaming.mode is "${mode}", expected "prioritize_low_latency" (R11b)`,
    );
  }
}

async function classifyFailure(resp: Response): Promise<LaunchBotResult> {
  let raw: unknown;
  let rawText = '';
  try {
    rawText = await resp.text();
    raw = JSON.parse(rawText);
  } catch {
    // Body wasn't JSON; carry text only.
  }

  // Recall returns DRF-style validation errors keyed by field name.
  // If we see a `meeting_url` key, it's the meeting URL itself.
  if (raw !== null && typeof raw === 'object' && 'meeting_url' in raw) {
    const detail = (raw as { meeting_url: unknown }).meeting_url;
    const message = Array.isArray(detail) ? detail.join('; ') : String(detail);
    return { success: false, errorCode: 'invalid_url', errorMessage: message };
  }

  // Generic 4xx — carry the detail field if present.
  const detail =
    raw !== null && typeof raw === 'object' && 'detail' in raw
      ? String((raw as { detail: unknown }).detail)
      : rawText.slice(0, 200);

  return {
    success: false,
    errorCode: 'client_error',
    errorMessage: `Recall ${resp.status}: ${detail}`,
  };
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function assertPositiveSeconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of seconds (got ${value})`);
  }
  return Math.floor(value);
}
