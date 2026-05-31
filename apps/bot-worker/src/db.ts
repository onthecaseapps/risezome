import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Utterance } from '@risezome/engine/transcribe';

/**
 * Service-role Supabase client. The bot-worker writes meeting_events
 * + cards + syntheses on behalf of meetings it owns; RLS would block
 * the writes via the publishable key, so we use the secret key. Every
 * call must explicitly filter by org_id (defense-in-depth) — the
 * cross-org grep check that lands later (per the plan's
 * Cross-tenant query enforcement decision) will catch any missing
 * scoping.
 */
export function createServiceClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SECRET_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
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
  meetingId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from('meetings')
    .update({ status: 'recording', started_at: new Date().toISOString() })
    .eq('meeting_id', meetingId)
    .in('status', ['launching', 'awaiting_recall', 'joining', 'waiting_room'])
    .select('meeting_id');
  if (error !== null) {
    // eslint-disable-next-line no-console
    console.error('[bot-worker.db] markRecording failed:', error);
    return false;
  }
  return (data ?? []).length > 0;
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
  const { data, error } = await client
    .from('meeting_events')
    .insert({
      meeting_id: args.meetingId,
      org_id: args.orgId,
      type: args.type,
      payload: args.payload,
    })
    .select('event_id')
    .single();

  if (error !== null) {
    // eslint-disable-next-line no-console
    console.error('[bot-worker.db] meeting_events insert failed:', error);
    return { eventId: null, broadcasted: false };
  }
  const eventId = data.event_id as number;

  // Broadcast under the meeting topic. We don't await an ack — Supabase
  // Realtime is fire-and-forget for our purposes; the DB write is the
  // durable source of truth and the portal's reconnect-fetch handles
  // missed broadcasts.
  try {
    const channel = client.channel(channelName(args.orgId, args.meetingId));
    await channel.subscribe();
    await channel.send({
      type: 'broadcast',
      event: args.type,
      payload: { ...args.payload, eventId },
    });
    // Tear down the per-broadcast channel so we don't leak subscriptions
    // across thousands of events. A pooled-channel optimization can come
    // later if Realtime overhead becomes measurable.
    await channel.unsubscribe();
    return { eventId, broadcasted: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[bot-worker.db] broadcast failed (event durable in DB):', err);
    return { eventId, broadcasted: false };
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
