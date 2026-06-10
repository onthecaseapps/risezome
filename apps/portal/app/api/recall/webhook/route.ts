import { NextResponse, type NextRequest } from 'next/server';
import { Webhook, WebhookVerificationError } from 'svix';
import { createServiceRoleClient } from '../../../_lib/supabase-server';
import { diagnosticForSubCode, statusForEvent } from '../../../_lib/bot-status-mapping';
import { inngest } from '../../../../src/inngest/client';

/**
 * Recall.ai bot lifecycle webhook receiver.
 *
 * Signature: Svix-style headers (`svix-id`, `svix-timestamp`,
 * `svix-signature`). The `svix` library verifies them; we configure
 * with the RECALL_WEBHOOK_SECRET set in the Recall.ai dashboard.
 *
 * Payload shape (Recall.ai docs):
 *   {
 *     event: "bot.in_call_recording",
 *     data: {
 *       bot: { id: "<recall_bot_id>", metadata?: {...} },
 *       data: { code?: "...", sub_code?: "..." }   // present for fatal
 *     }
 *   }
 *
 * We resolve the bot_id to a meetings row, then either update status
 * (normal lifecycle) or mark failed + carry an error_code/message
 * (fatal / permission_denied).
 *
 * Idempotency: Recall retries on 5xx and may double-fire. We rely on
 * idempotent status-transition logic — the same incoming event
 * applied twice converges to the same row state. No svix-id dedupe
 * table needed at MVP scale.
 *
 * On bot.call_ended we POST to the bot-worker's /meetings/:id/end
 * endpoint so it can flush in-memory state. Best-effort — if the
 * bot-worker is unreachable we still mark completed in DB.
 */

interface RecallWebhookPayload {
  event?: string;
  data?: {
    bot?: { id?: string };
    data?: {
      code?: string;
      sub_code?: string;
    };
  };
}

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env['RECALL_WEBHOOK_SECRET'];
  if (secret === undefined || secret.length === 0) {
    return new NextResponse('Server misconfigured (RECALL_WEBHOOK_SECRET unset)', { status: 500 });
  }

  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');
  if (svixId === null || svixTimestamp === null || svixSignature === null) {
    return new NextResponse('Missing svix headers', { status: 400 });
  }

  // Verify against the raw body — JSON.parse + stringify would change
  // bytes and break the signature.
  const raw = await request.text();
  let verified: unknown;
  try {
    const wh = new Webhook(secret);
    verified = wh.verify(raw, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return new NextResponse('Invalid signature', { status: 401 });
    }
    return new NextResponse('Verification error', { status: 400 });
  }

  const payload = verified as RecallWebhookPayload;
  const eventType = payload.event;
  const botId = payload.data?.bot?.id;

  if (typeof eventType !== 'string') {
    return NextResponse.json({ ok: true, ignored: 'no_event' });
  }
  if (typeof botId !== 'string' || botId.length === 0) {
    // bot.* events should always carry a bot id; an event without one
    // is malformed but we 200 so Recall doesn't retry endlessly.
    return NextResponse.json({ ok: true, ignored: 'no_bot_id' });
  }

  const newStatus = statusForEvent(eventType);
  if (newStatus === null) {
    // Recognized but no DB change required (bot.done — Recall's
    // "we're finished processing" signal). Future: signal the bot-worker
    // to flush, if we haven't already done so on bot.call_ended.
    return NextResponse.json({ ok: true, eventType, action: 'no_change' });
  }

  const service = createServiceRoleClient();

  // Look up the meeting via recall_bot_id. RLS would block under the
  // user-scoped client; service-role is the right choice for webhooks.
  // service-role-cross-org: Recall webhook carries no org; recall_bot_id (Recall's
  // globally-unique id) is the trusted key that resolves org_id.
  const { data: meeting, error: lookupErr } = await service
    .from('meetings')
    .select('meeting_id, org_id, status')
    .eq('recall_bot_id', botId)
    .maybeSingle();
  if (lookupErr !== null) {
    console.error('[recall.webhook] meeting lookup failed:', lookupErr);
    return new NextResponse('DB error', { status: 500 });
  }
  if (meeting === null) {
    // Bot id we don't know — Recall may be replaying for a bot we
    // never created (e.g. during dev with a shared Recall account).
    // 200 to stop retries.
    return NextResponse.json({ ok: true, ignored: 'unknown_bot' });
  }

  // Build update payload — failure path carries error_code + message.
  const update: Record<string, unknown> = { status: newStatus };
  if (newStatus === 'failed') {
    const subCode = payload.data?.data?.sub_code ?? payload.data?.data?.code;
    const diag = diagnosticForSubCode(subCode);
    update['error_code'] = diag.code;
    update['error_message'] = diag.message;
  }
  if (newStatus === 'completed') {
    update['ended_at'] = new Date().toISOString();
  }

  // Transition guard: Recall can double-fire call_ended; without the .neq an
  // already-completed meeting re-ran the full Claude recap (re-billed AND
  // mutated a manager-visible recap) and re-enqueued gap assembly on every
  // duplicate. Zero rows updated ⇒ no transition happened ⇒ skip the side
  // effects below.
  const { data: transitioned, error: updateErr } = await service
    .from('meetings')
    .update(update)
    .eq('meeting_id', meeting.meeting_id)
    .eq('org_id', meeting.org_id) // defense-in-depth: service-role bypasses RLS, scope by the org resolved from the bot_id lookup
    .neq('status', newStatus)
    .select('meeting_id');
  if (updateErr !== null) {
    console.error('[recall.webhook] meeting update failed:', updateErr);
    return new NextResponse('DB error', { status: 500 });
  }
  if (transitioned === null || transitioned.length === 0) {
    return NextResponse.json({ ok: true, ignored: 'no_transition', newStatus });
  }

  // Best-effort broadcast so the live page swaps shells without a
  // reload. The bot-worker will also broadcast meetingStatus on its
  // own status transitions, but this catches the cases where the
  // bot-worker isn't running (failed launches, completed meetings).
  // Mirror the bot-worker's broadcast shape: meeting_events row +
  // Realtime broadcast.
  void broadcastStatus(service, {
    meetingId: meeting.meeting_id as string,
    orgId: meeting.org_id as string,
    status: newStatus,
    errorMessage:
      typeof update['error_message'] === 'string' ? (update['error_message'] as string) : null,
  });

  // On call_ended, ping the bot-worker to flush. Fire-and-forget.
  if (newStatus === 'completed') {
    void notifyBotWorkerEnd(meeting.meeting_id as string);
    // Kick off the whole-meeting AI recap (U7). Best-effort — a failed
    // enqueue must not fail the webhook; the recap is a review-page nicety.
    void inngest
      .send({
        name: 'risezome/meeting.recap-requested',
        data: { meetingId: meeting.meeting_id as string, orgId: meeting.org_id as string },
      })
      .catch((err: unknown) => {
        console.error('[recall.webhook] recap enqueue failed:', err);
      });
    // Assemble knowledge gaps from this meeting's misses (U6). Best-effort —
    // a failed enqueue must not fail the webhook.
    void inngest
      .send({
        name: 'risezome/meeting.gaps-requested',
        data: { meetingId: meeting.meeting_id as string, orgId: meeting.org_id as string },
      })
      .catch((err: unknown) => {
        console.error('[recall.webhook] gaps enqueue failed:', err);
      });
  }

  return NextResponse.json({
    ok: true,
    eventType,
    meetingId: meeting.meeting_id,
    newStatus,
  });
}

async function broadcastStatus(
  service: ReturnType<typeof createServiceRoleClient>,
  args: { meetingId: string; orgId: string; status: string; errorMessage: string | null },
): Promise<void> {
  const payload: Record<string, unknown> = {
    status: args.status,
    at: new Date().toISOString(),
  };
  if (args.errorMessage !== null) payload['errorMessage'] = args.errorMessage;

  const { data, error } = await service
    .from('meeting_events')
    .insert({
      meeting_id: args.meetingId,
      org_id: args.orgId,
      type: 'meetingStatus',
      payload,
    })
    .select('event_id')
    .single();
  if (error !== null) {
    console.warn('[recall.webhook] meeting_events insert failed:', error);
    return;
  }

  try {
    const channel = service.channel(`meeting:${args.orgId}:${args.meetingId}`);
    await channel.subscribe();
    await channel.send({
      type: 'broadcast',
      event: 'meetingStatus',
      payload: { ...payload, eventId: data.event_id as number },
    });
    await channel.unsubscribe();
  } catch (err) {
    console.warn('[recall.webhook] broadcast failed:', err);
  }
}

async function notifyBotWorkerEnd(meetingId: string): Promise<void> {
  const base = process.env['BOT_WORKER_HTTP_URL'];
  if (base === undefined || base.length === 0) return;
  try {
    await fetch(`${base.replace(/\/$/, '')}/meetings/${encodeURIComponent(meetingId)}/end`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // U12: authenticate to the bot-worker's control endpoint.
        authorization: `Bearer ${process.env['BOT_WORKER_SECRET'] ?? ''}`,
      },
      body: '{}',
    });
  } catch (err) {
    console.warn('[recall.webhook] bot-worker end notify failed:', err);
  }
}
