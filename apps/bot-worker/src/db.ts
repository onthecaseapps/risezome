import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Utterance } from '@risezome/engine/transcribe';
import { CRYPTO_VERSION, encryptForOrgToBytea, EnvelopeCryptoError } from '@risezome/crypto';

/**
 * Service-role Supabase client. The bot-worker writes meeting_events
 * + cards + syntheses on behalf of meetings it owns; RLS would block
 * the writes via the publishable key, so we use the secret key. Every
 * call must explicitly filter by org_id (defense-in-depth) — the
 * cross-org enforcement guard now exists at
 * scripts/lint/check-service-role-org-scope.mjs (run via
 * `pnpm lint:org-scope`) and fails CI on any service-role `.from(<org-scoped
 * table>)` chain missing an org_id predicate. This file is registered as a
 * service-role module in that guard, so every org-scoped `.from` chain here is
 * checked regardless of how the client is obtained.
 */
export function createServiceClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SECRET_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  }) as SupabaseClient;
}

/**
 * On first utterance for a meeting, flip status to 'recording' so
 * the live page swaps from the joining-shell to the recording HUD.
 * Idempotent: subsequent calls are no-ops because of the WHERE clause
 * gating on the prior status.
 *
 * U10 (Recall webhook handler) is the canonical source for status
 * transitions in production — bot.in_call_recording flips status.
 * Until U10 lands, this is the dev-time path that lights up the UI.
 */
export async function markRecordingIfFirst(
  client: SupabaseClient,
  args: { meetingId: string; orgId: string },
): Promise<boolean> {
  const { data, error } = await client
    .from('meetings')
    .update({ status: 'recording', started_at: new Date().toISOString() })
    .eq('meeting_id', args.meetingId)
    .eq('org_id', args.orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    .in('status', ['launching', 'awaiting_recall', 'joining', 'waiting_room'])
    .select('meeting_id');
  if (error !== null) {
    console.error('[bot-worker.db] markRecording failed:', error);
    return false;
  }
  const flipped = (data ?? []).length > 0;
  if (flipped) {
    // Emit a meetingStatus broadcast + meeting_events row so the
    // live page can swap from joining-shell to recording HUD without
    // needing a reload. Best-effort; the page also falls back to
    // initial DB fetch on reload.
    await persistAndBroadcast(client, {
      meetingId: args.meetingId,
      orgId: args.orgId,
      type: 'meetingStatus',
      payload: { status: 'recording', at: new Date().toISOString() },
    });
  }
  return flipped;
}

/**
 * Insert a meeting_events row and broadcast the same payload on
 * Supabase Realtime in one logical operation. R23a: DB write FIRST,
 * broadcast SECOND. If broadcast fails the event is still durable in
 * the DB and the portal recovers via reconnect-fetch (U11b).
 */
export async function persistAndBroadcast(
  client: SupabaseClient,
  args: { meetingId: string; orgId: string; type: string; payload: Record<string, unknown> },
): Promise<{ eventId: number | null; broadcasted: boolean }> {
  // F2: for transcript events, encrypt the verbatim text at rest. The stored
  // payload omits `text` (speaker/timing/ids stay plaintext so capture_card_stats
  // keeps working); the text lives encrypted in transcript_text_enc. The
  // broadcast below still carries the full plaintext payload to live participants.
  let storedPayload = args.payload;
  let transcriptTextEnc: string | null = null;
  let transcriptKeyVersion: number | null = null;
  const textVal = args.payload.text;
  if (args.type === 'transcript.data' && typeof textVal === 'string') {
    const { text: _text, ...rest } = args.payload;
    storedPayload = rest;
    // U9: encrypt under the org's per-org KMS key (app-side ESDK). The Buffer is
    // serialized to the bytea hex-text literal supabase-js needs (a raw Buffer
    // would be JSON-mangled into the column). transcript_key_version=2 marks the
    // KMS-ESDK format (1 = legacy pgcrypto) so the U11 migration can find
    // un-migrated rows.
    //
    // DEGRADE, never crash the meeting: a KMS blip here must NOT throw out of
    // this fire-and-forget path (handleMessage awaits nothing), which would lose
    // the transcript row entirely. On EnvelopeCryptoError we persist the row with
    // a NULL ciphertext + null version so the speaker/timing metadata still lands
    // and the live broadcast below (which carries plaintext) is unaffected. The
    // un-encrypted-at-rest row is acceptable: the verbatim text is simply absent
    // from durable storage for this utterance rather than the whole row being
    // dropped. We log at error level WITHOUT any plaintext.
    try {
      transcriptTextEnc = await encryptForOrgToBytea(args.orgId, textVal);
      transcriptKeyVersion = CRYPTO_VERSION.KMS_ESDK;
    } catch (err) {
      if (err instanceof EnvelopeCryptoError) {
        console.error(
          `[bot-worker.db] transcript encrypt failed (KMS); persisting row without encrypted text ` +
            `(meetingId=${args.meetingId} orgId=${args.orgId})`,
          err,
        );
        transcriptTextEnc = null;
        transcriptKeyVersion = null;
      } else {
        throw err;
      }
    }
  }
  // transcript_key_version is `NOT NULL DEFAULT 1` (legacy marker). Only
  // transcript rows with actual ciphertext carry a version (KMS_ESDK=2); for
  // every other row — non-transcript events AND degraded transcript rows whose
  // encryption failed (null ciphertext) — we OMIT both columns so the column
  // default (1) applies. Writing an explicit null here defeats the default and
  // violates the NOT NULL constraint, which would drop every event.
  const insertRow: Record<string, unknown> = {
    meeting_id: args.meetingId,
    org_id: args.orgId,
    type: args.type,
    payload: storedPayload,
  };
  if (transcriptTextEnc !== null) {
    insertRow.transcript_text_enc = transcriptTextEnc;
    insertRow.transcript_key_version = transcriptKeyVersion;
  }
  const { data, error } = await client
    .from('meeting_events')
    .insert(insertRow)
    .select('event_id')
    .single();

  if (error !== null) {
    console.error('[bot-worker.db] meeting_events insert failed:', error);
    return { eventId: null, broadcasted: false };
  }
  const eventId = data.event_id as number;

  // Broadcast under the meeting topic. We pool one channel per meeting
  // so we pay the subscribe cost once, not per-event. Earlier we did
  // subscribe + send + unsubscribe per broadcast — `channel.subscribe()`
  // returns synchronously but the actual server-side subscription is
  // async; sending immediately after races with the SUBSCRIBED ack and
  // the message gets dropped server-side. Result: DB writes worked but
  // broadcasts never reached the browser.
  try {
    const channel = await getOrSubscribeChannel(client, args.orgId, args.meetingId);
    const sendResult = await channel.send({
      type: 'broadcast',
      event: args.type,
      payload: { ...args.payload, eventId },
    });
    const broadcasted = sendResult === 'ok';
    if (!broadcasted) {
      console.warn(
        `[bot-worker.db] broadcast send returned ${String(sendResult)} (event durable in DB)`,
      );
    }
    return { eventId, broadcasted };
  } catch (err) {
    console.warn('[bot-worker.db] broadcast failed (event durable in DB):', err);
    return { eventId, broadcasted: false };
  }
}

/**
 * Per-meeting channel pool. Channels are long-lived for the meeting's
 * lifetime; the bot-worker process holds them open in memory. On meeting
 * end (POST /meetings/:id/end), the runtime is torn down and the channel
 * is removed via teardownChannelForMeeting.
 */
const channelPool = new Map<string, Awaited<ReturnType<typeof subscribeChannel>>>();

async function getOrSubscribeChannel(
  client: SupabaseClient,
  orgId: string,
  meetingId: string,
): Promise<ReturnType<SupabaseClient['channel']>> {
  const name = channelName(orgId, meetingId);
  const existing = channelPool.get(name);
  if (existing !== undefined) return existing;
  const channel = await subscribeChannel(client, name);
  channelPool.set(name, channel);
  return channel;
}

async function subscribeChannel(
  client: SupabaseClient,
  name: string,
): Promise<ReturnType<SupabaseClient['channel']>> {
  const channel = client.channel(name);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`subscribe timeout for ${name}`));
    }, 5000);
    channel.subscribe((status: string, err) => {
      if (settled) return;
      if (status === 'SUBSCRIBED') {
        settled = true;
        clearTimeout(timeout);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`subscribe ${status}${err !== undefined ? `: ${String(err)}` : ''}`));
      }
    });
  });
  return channel;
}

export async function teardownChannelForMeeting(
  client: SupabaseClient,
  orgId: string,
  meetingId: string,
): Promise<void> {
  const name = channelName(orgId, meetingId);
  const ch = channelPool.get(name);
  if (ch === undefined) return;
  channelPool.delete(name);
  try {
    await client.removeChannel(ch);
  } catch {
    // best-effort
  }
}

export function channelName(orgId: string, meetingId: string): string {
  return `meeting:${orgId}:${meetingId}`;
}

export function utteranceToEventPayload(u: Utterance): Record<string, unknown> {
  return {
    utteranceId: u.utteranceId,
    text: u.text,
    isFinal: u.isFinal,
    speaker: u.speaker ?? null,
    startMs: u.startMs,
    endMs: u.endMs,
    revision: u.revision,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
