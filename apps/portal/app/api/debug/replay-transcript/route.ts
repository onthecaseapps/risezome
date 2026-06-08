import { NextResponse } from 'next/server';
import { EnvelopeCryptoError } from '@risezome/crypto';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { createServerClient } from '../../../_lib/supabase-server';
import { transcriptWithText } from '../../../_lib/transcript';
import { toReplayUtterances } from '../../../(authed)/debug/live-mic/_replay-source';

/**
 * Debug-only transcript source for the live-mic replay harness (U2). Returns a
 * past meeting's transcript as ordered `ReplayUtterance[]` for the page to replay
 * through the real pipeline. Org-scoped exactly like the live events route
 * (`api/meetings/[meetingId]/events`): the RLS client + the explicit org filter
 * in `transcriptWithText` ensure only the caller's own org's meeting is returned.
 * Transcript text is decrypted server-side (the browser never sees the key);
 * degrade to a typed 500 on a crypto failure rather than leaking.
 *
 * Guarded to non-production (debug tooling, never a shipping surface) — mirrors
 * `api/dev/local-meeting`.
 */
export async function GET(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('not found', { status: 404 });
  }

  const meetingId = new URL(req.url).searchParams.get('meetingId');
  if (meetingId === null || meetingId.length === 0) {
    return NextResponse.json({ ok: false, error: 'missing_meeting_id' }, { status: 400 });
  }

  try {
    const { orgId } = await requireAuthedUserWithOrg();
    const supabase = await createServerClient();
    const rows = await transcriptWithText(supabase, meetingId, orgId);
    return NextResponse.json({ ok: true, utterances: toReplayUtterances(rows) });
  } catch (err) {
    if (err instanceof EnvelopeCryptoError) {
      console.error(`[replay-transcript] decrypt failed (meetingId=${meetingId}):`, err);
      return NextResponse.json({ ok: false, error: 'transcript_decrypt_failed' }, { status: 500 });
    }
    throw err;
  }
}
