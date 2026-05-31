'use server';

import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServiceRoleClient } from '../../../../_lib/supabase-server';

/**
 * Pin or unpin a card. Toggle is stored on `cards.pinned`. We also bump
 * `pinned_at` to the current time on pin (null on unpin) so future
 * consumers can sort or render "pinned 3m ago".
 *
 * RLS allows org members to UPDATE their org's cards; we additionally
 * verify org membership through requireAuthedUserWithOrg + a service-role
 * filter on (card_id, org_id) so a forged client can't pin/unpin a
 * different org's card.
 *
 * After the write succeeds, broadcast a `cardUpdated` event on the
 * meeting's Realtime channel so other open tabs (other meeting members)
 * see the pin update without a refresh.
 */
export async function pinCardAction(
  cardId: string,
  pinned: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  // Fetch meeting_id so we can broadcast to the right channel.
  const { data: cardRow, error: lookupErr } = await service
    .from('cards')
    .select('card_id, meeting_id, retracted_at')
    .eq('card_id', cardId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (lookupErr !== null) return { ok: false, error: lookupErr.message };
  if (cardRow === null) return { ok: false, error: 'card_not_found' };
  if (cardRow.retracted_at !== null) return { ok: false, error: 'card_retracted' };

  const { error: updateErr } = await service
    .from('cards')
    .update({
      pinned,
      pinned_at: pinned ? new Date().toISOString() : null,
    })
    .eq('card_id', cardId)
    .eq('org_id', orgId);
  if (updateErr !== null) return { ok: false, error: updateErr.message };

  // Broadcast so other tabs see the pin update live. Mirrors the
  // bot-worker's persistAndBroadcast pattern but only does the broadcast
  // (no meeting_events row — pin changes are not part of the
  // append-only event log).
  await broadcastCardUpdated(service, {
    orgId,
    meetingId: cardRow.meeting_id as string,
    cardId,
    update: { pinned },
  });

  return { ok: true };
}

/**
 * Dismiss a card. Sets `retracted_at` to now + `retracted_reason` to
 * 'manual-dismiss'. Soft-delete pattern; the row stays so the historical
 * record is intact for /review.
 */
export async function dismissCardAction(
  cardId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { orgId } = await requireAuthedUserWithOrg();
  const service = createServiceRoleClient();

  const { data: cardRow, error: lookupErr } = await service
    .from('cards')
    .select('card_id, meeting_id, retracted_at')
    .eq('card_id', cardId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (lookupErr !== null) return { ok: false, error: lookupErr.message };
  if (cardRow === null) return { ok: false, error: 'card_not_found' };
  if (cardRow.retracted_at !== null) return { ok: true }; // already dismissed; idempotent

  const { error: updateErr } = await service
    .from('cards')
    .update({
      retracted_at: new Date().toISOString(),
      retracted_reason: 'manual-dismiss',
    })
    .eq('card_id', cardId)
    .eq('org_id', orgId);
  if (updateErr !== null) return { ok: false, error: updateErr.message };

  await broadcastCardRetracted(service, {
    orgId,
    meetingId: cardRow.meeting_id as string,
    cardId,
    reason: 'manual-dismiss',
  });

  return { ok: true };
}

async function broadcastCardUpdated(
  service: ReturnType<typeof createServiceRoleClient>,
  args: { orgId: string; meetingId: string; cardId: string; update: { pinned?: boolean } },
): Promise<void> {
  const topic = `meeting:${args.orgId}:${args.meetingId}`;
  const channel = service.channel(topic);
  await new Promise<void>((resolve) => {
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') resolve();
    });
    setTimeout(resolve, 3000);
  });
  await channel.send({
    type: 'broadcast',
    event: 'cardUpdated',
    payload: { update: { cardId: args.cardId, ...args.update } },
  });
  await service.removeChannel(channel);
}

async function broadcastCardRetracted(
  service: ReturnType<typeof createServiceRoleClient>,
  args: { orgId: string; meetingId: string; cardId: string; reason: 'manual-dismiss' },
): Promise<void> {
  const topic = `meeting:${args.orgId}:${args.meetingId}`;
  const channel = service.channel(topic);
  await new Promise<void>((resolve) => {
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') resolve();
    });
    setTimeout(resolve, 3000);
  });
  await channel.send({
    type: 'broadcast',
    event: 'cardRetracted',
    payload: { retracted: { cardId: args.cardId, reason: args.reason } },
  });
  await service.removeChannel(channel);
}
