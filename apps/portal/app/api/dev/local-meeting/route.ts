import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '../../../_lib/supabase-server';
import { inngest } from '../../../../src/inngest/client';

/**
 * Dev-only local-meeting lifecycle API (security/dogfood tooling).
 *
 * Drives a meeting captured from the local mic sidecar instead of a Recall bot
 * (see apps/bot-worker/src/debug/local-capture.ts). The dev console calls:
 *   - `start` → mint an ad-hoc `meetings` row (no calendar event) in the dev
 *     org, status 'recording', flagged local via null conference_url/
 *     calendar_event_id + a "Local meeting …" title (KTD3, no migration).
 *   - `stop`  → mark the meeting 'completed' + ended_at and fire the SAME
 *     post-meeting jobs the Recall webhook fires (recap + knowledge-gaps), so
 *     it lands in Captures/Review with full fidelity (KTD4).
 *
 * Guarded to non-production (this is dev tooling, never a shipping surface)
 * AND to callers presenting the BOT_WORKER_SECRET bearer (the dev console
 * already holds it for the bot-worker control surface). The secret gate is
 * defense-in-depth beyond NODE_ENV: a preview/staging deploy where NODE_ENV
 * isn't exactly "production" must not expose cross-tenant org enumeration or
 * meeting creation to anonymous callers. Fail-closed: no secret configured →
 * 404, same as production.
 *
 * Service-role throughout — there is no user session; the dev org/user are
 * resolved from env (RISEZOME_DEV_ORG_ID / RISEZOME_DEV_USER_ID) or a
 * deterministic fallback (KTD8).
 */

interface Body {
  action?: 'start' | 'stop' | 'orgs';
  meetingId?: string;
  orgId?: string;
}

function notFound(): NextResponse {
  return new NextResponse('not found', { status: 404 });
}

/** Constant-time bearer check (sha256 digests so lengths always match). */
function bearerMatches(authorization: string | null, secret: string): boolean {
  if (authorization === null || !authorization.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(authorization.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(presented, expected);
}

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') return notFound();
  // Defense-in-depth beyond NODE_ENV (see header comment): require the shared
  // dev-tooling secret. Unset secret → fail closed.
  const secret = process.env.BOT_WORKER_SECRET ?? '';
  if (secret.length === 0 || !bearerMatches(req.headers.get('authorization'), secret)) {
    return notFound();
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const service = createServiceRoleClient();

  if (body.action === 'orgs') {
    // List orgs so the dev console can offer a picker (the chosen org must match
    // the browser session's active org for the live page to find the meeting).
    const { data, error } = await service
      .from('orgs')
      .select('id, name')
      .order('created_at', { ascending: true });
    if (error !== null) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    const defaultOrgId = process.env.RISEZOME_DEV_ORG_ID ?? null;
    return NextResponse.json({ ok: true, orgs: data ?? [], defaultOrgId });
  }

  if (body.action === 'start') {
    let identity: { orgId: string; userId: string };
    try {
      identity = await resolveDevIdentity(service, body.orgId);
    } catch (err) {
      return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
    }
    const title = `Local meeting ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
    const { data, error } = await service
      .from('meetings')
      .insert({
        org_id: identity.orgId,
        user_id: identity.userId,
        status: 'recording',
        title,
        started_at: new Date().toISOString(),
        // conference_url + calendar_event_id stay null — the local-meeting flag
        // (KTD3) and what keeps it out of the live-dedup index.
      })
      .select('meeting_id')
      .single();
    if (error !== null || data === null) {
      return NextResponse.json(
        { ok: false, error: error?.message ?? 'meeting insert failed' },
        { status: 500 },
      );
    }
    const meetingId = data.meeting_id as string;

    // Register the dev user as a participant. The meetings (and cards/syntheses/
    // realtime) SELECT policies are participant-scoped via is_meeting_participant
    // (migration 20260603330000) — NOT org-membership — so without this row the
    // user-scoped live page reads null and 404s, even though the meeting is in
    // the user's org. The production launch path writes this row too.
    const { error: partErr } = await service
      .from('meeting_participants')
      .insert({ meeting_id: meetingId, user_id: identity.userId });
    if (partErr !== null) {
      return NextResponse.json(
        { ok: false, error: `participant insert failed: ${partErr.message}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, meetingId, orgId: identity.orgId });
  }

  if (body.action === 'stop') {
    const { meetingId, orgId } = body;
    if (typeof meetingId !== 'string' || typeof orgId !== 'string') {
      return NextResponse.json({ ok: false, error: 'meetingId + orgId required' }, { status: 400 });
    }
    const { data: updated, error } = await service
      .from('meetings')
      .update({ status: 'completed', ended_at: new Date().toISOString() })
      .eq('meeting_id', meetingId)
      .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS
      .select('meeting_id');
    if (error !== null) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (updated === null || updated.length === 0) {
      // Unknown / foreign-org meeting — do NOT fire the post-meeting jobs.
      return NextResponse.json({ ok: false, error: 'meeting not found' }, { status: 404 });
    }

    // Mirror the Recall webhook's completion: fire BOTH the recap and the
    // knowledge-gaps jobs so the local meeting exercises the full post-meeting
    // feature set (KTD4). Best-effort — a failed enqueue must not fail the stop.
    await inngest
      .send({ name: 'risezome/meeting.recap-requested', data: { meetingId, orgId } })
      .catch((err: unknown) => console.error('[dev.local-meeting] recap enqueue failed:', err));
    await inngest
      .send({ name: 'risezome/meeting.gaps-requested', data: { meetingId, orgId } })
      .catch((err: unknown) => console.error('[dev.local-meeting] gaps enqueue failed:', err));

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: 'unknown action (expected start|stop)' }, { status: 400 });
}

/**
 * Resolve the dev org + a user to own the ad-hoc meeting (KTD8). Prefers the
 * RISEZOME_DEV_ORG_ID / RISEZOME_DEV_USER_ID env vars; otherwise falls back
 * deterministically to the oldest org and that org's oldest member.
 */
async function resolveDevIdentity(
  service: ReturnType<typeof createServiceRoleClient>,
  orgIdOverride: string | undefined,
): Promise<{ orgId: string; userId: string }> {
  let orgId = orgIdOverride ?? process.env.RISEZOME_DEV_ORG_ID ?? '';
  if (orgId.length === 0) {
    const { data } = await service
      .from('orgs')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data === null) throw new Error('no org found to host the local meeting (set RISEZOME_DEV_ORG_ID)');
    orgId = data.id as string;
  }

  let userId = process.env.RISEZOME_DEV_USER_ID ?? '';
  if (userId.length === 0) {
    const { data } = await service
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .order('joined_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data === null) {
      throw new Error(`no member found for org ${orgId} (set RISEZOME_DEV_USER_ID)`);
    }
    userId = data.user_id as string;
  }

  return { orgId, userId };
}
