import { NextResponse } from 'next/server';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient } from '../../../../_lib/supabase-server';
import { decryptForOrgFromBytea, EnvelopeCryptoError } from '@risezome/crypto';

/**
 * Incremental meeting-events feed for the live page's content poll.
 *
 * Why this exists: transcript text is encrypted at rest (transcript_text_enc) and
 * STRIPPED from meeting_events.payload, so the browser-side poll that read
 * meeting_events directly could never surface live transcript — only the
 * server-rendered seed (which decrypts) showed it, so the transcript appeared
 * only on a manual refresh. The Realtime broadcast carries plaintext but has
 * proven unreliable. This route is the deterministic path: read the new events
 * server-side (RLS still participant-scopes via createServerClient), decrypt the
 * transcript text, and hand back payloads shaped exactly like the live broadcast
 * so the same reducer mapping applies.
 *
 * Returns events with event_id > `after`, ascending. Org is derived from the
 * session (never trusted from the client); RLS + the explicit org filter scope
 * the read to meetings the caller may see.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ meetingId: string }> },
): Promise<NextResponse> {
  const { meetingId } = await ctx.params;
  const { orgId } = await requireAuthedUserWithOrg();

  const after = Number.parseInt(new URL(req.url).searchParams.get('after') ?? '0', 10);
  const afterEventId = Number.isFinite(after) && after > 0 ? after : 0;

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('meeting_events')
    .select('event_id, type, payload, transcript_text_enc')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId) // defense-in-depth alongside participant-scoped RLS
    .gt('event_id', afterEventId)
    .order('event_id', { ascending: true });
  if (error !== null) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as {
    event_id: number;
    type: string;
    payload: Record<string, unknown> | null;
    transcript_text_enc: string | null;
  }[];

  const events = await Promise.all(
    rows.map(async (r) => {
      const payload: Record<string, unknown> = { ...(r.payload ?? {}) };
      // Re-attach the decrypted transcript text the bot-worker stripped before
      // persisting. DEGRADE on a KMS blip: leave text absent (the reducer drops
      // that one utterance) rather than 500 the whole poll.
      if (r.type === 'transcript.data' && r.transcript_text_enc !== null) {
        try {
          payload['text'] = await decryptForOrgFromBytea(orgId, r.transcript_text_enc);
        } catch (err) {
          if (!(err instanceof EnvelopeCryptoError)) throw err;
          console.error(`[meeting-events] transcript decrypt failed (meetingId=${meetingId})`, err);
        }
      }
      return { event_id: r.event_id, type: r.type, payload };
    }),
  );

  const maxEventId = events.length > 0 ? events[events.length - 1]!.event_id : afterEventId;
  return NextResponse.json({ ok: true, events, maxEventId });
}
