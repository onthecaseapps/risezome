import type { ReactElement } from 'react';
import { cookies } from 'next/headers';
import { decryptForOrgFromBytea, EnvelopeCryptoError } from '@risezome/crypto';
import { CURRENT_TEAM_COOKIE, listUserTeams, requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient, createServiceRoleClient } from '../../_lib/supabase-server';
import { isMasterKeyAccess } from '../../_lib/meeting-access';
import { applyTeamLens } from './_team-lens';
import { structuredRecapOverview } from './_recap-preview';
import { CapturesClient, type CaptureCard, type CapturePlatform } from './_client';

/**
 * Captures — the historical record of past meetings the bot attended.
 * Lists meetings in terminal states (completed / failed) for the current org
 * as a filterable card grid (the client owns search / filter / sort over the
 * fetched set; the cap is small enough that client-side is fine).
 *
 * `recording` + mid-flight statuses are excluded (those belong on Live meeting).
 *
 * Per-meeting aggregates (answers, sources, distinct speakers) come from the
 * `capture_card_stats` RPC in ONE round trip. If that RPC isn't present yet
 * (migration not applied), we fall back to JS-tallied answer/source counts and
 * no speaker avatars, so the page degrades instead of erroring.
 */

/**
 * Cap on how many meetings' recaps we decrypt for the list preview per render.
 * Each is a distinct KMS Decrypt (recaps don't share a data key), so this bounds
 * the captures-list KMS cost; the rest decrypt lazily on the review page.
 */
const RECAP_PREVIEW_LIMIT = 30;

function platformFromUrl(url: string | null): CapturePlatform {
  if (url === null) return 'other';
  const u = url.toLowerCase();
  if (u.includes('zoom.us') || u.includes('zoom.com')) return 'zoom';
  if (u.includes('meet.google.com')) return 'meet';
  if (u.includes('teams.microsoft') || u.includes('teams.live')) return 'teams';
  return 'other';
}

export default async function CapturesPage(): Promise<ReactElement> {
  const { user, orgId, orgName, role } = await requireAuthedUserWithOrg();
  const supabase = await createServerClient();

  const { data: meetingRows } = await supabase
    .from('meetings')
    .select(
      'meeting_id, user_id, status, started_at, ended_at, error_code, error_message, calendar_event_id, title, conference_url, recap_text_enc, recap_json_enc, recap_status, created_at',
    )
    .eq('org_id', orgId)
    .in('status', ['completed', 'failed'])
    .order('created_at', { ascending: false })
    .limit(100);

  const allMeetings = (meetingRows ?? []) as Array<{
    meeting_id: string;
    user_id: string;
    status: 'completed' | 'failed';
    started_at: string | null;
    ended_at: string | null;
    error_code: string | null;
    error_message: string | null;
    calendar_event_id: string | null;
    title: string;
    conference_url: string | null;
    recap_text_enc: string | null;
    recap_json_enc: string | null;
    recap_status: 'generating' | 'done' | 'failed' | null;
    created_at: string;
  }>;

  // P1-B (master-key audit gap): RLS grants a super_admin EVERY meeting in their
  // org, including meetings they neither own nor attended. The library would list
  // + decrypt those recaps with NO audit row (only the review/live detail pages
  // audit a master-key view). EXCLUDE those master-key-only meetings from the list
  // so a super_admin sees only meetings they are genuinely entitled to (owner /
  // participant); non-attended meetings appear only when deliberately opened via
  // review/live, which records the master_key_access audit row. Non-super_admin
  // behavior is unchanged: isMasterKeyAccess is false for any non-super_admin, so
  // the filter is a no-op for them (and RLS already hides those rows anyway).
  let meetings = allMeetings;
  if (role === 'super_admin') {
    // Resolve the viewer's participant set in ONE query (not per-meeting) over the
    // meetings they do NOT own, so the attendee entitlement can be checked without
    // N round-trips.
    const notOwnedIds = allMeetings
      .filter((m) => m.user_id !== user.id)
      .map((m) => m.meeting_id);
    const participantOf = new Set<string>();
    if (notOwnedIds.length > 0) {
      const service = createServiceRoleClient();
      const { data: parts } = await service
        .from('meeting_participants')
        .select('meeting_id')
        .eq('user_id', user.id)
        .in('meeting_id', notOwnedIds);
      for (const p of parts ?? []) participantOf.add(p.meeting_id as string);
    }
    meetings = allMeetings.filter(
      (m) =>
        !isMasterKeyAccess({
          role,
          viewerId: user.id,
          ownerId: m.user_id,
          isParticipant: participantOf.has(m.meeting_id),
        }),
    );
  }

  // U8 — team-switcher BROWSE LENS. The top-bar team switcher writes
  // CURRENT_TEAM_COOKIE; absent (or a team the user is no longer on / archived)
  // = the "All meetings" lens (current behavior, unchanged). When a team IS
  // selected, NARROW the list to meetings that INVOLVE that team — meetings with
  // ≥1 attendee (meeting_participants) who is a member (team_members) of the
  // selected team — INTERSECTED with the meetings already in `meetings`. We
  // resolve the "involved" set from the already-RLS-scoped accessible
  // meeting_ids (one extra query keyed by those ids + the team_id), then apply
  // the pure filter. The lens only NARROWS: it filters the genuinely-entitled
  // rows, so it can never widen access (RLS still scopes meetings to attendees ∪
  // super-admin, U2). Validate the cookie against the user's own teams so a
  // stale/foreign team id falls back to no-lens (show all) rather than erroring.
  const cookieStore = await cookies();
  const teamCookie = cookieStore.get(CURRENT_TEAM_COOKIE)?.value;
  if (teamCookie !== undefined && teamCookie !== 'all' && meetings.length > 0) {
    const userTeams = await listUserTeams(orgId);
    const teamId = userTeams.some((t) => t.id === teamCookie) ? teamCookie : null;
    if (teamId !== null) {
      const accessibleIds = meetings.map((m) => m.meeting_id);
      // meeting_participants ⋈ team_members for the selected team, restricted to
      // the accessible meetings. Both tables are member-readable under RLS.
      const { data: memberRows } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', teamId);
      const teamUserIds = (memberRows ?? []).map((r) => r.user_id as string);
      const involved = new Set<string>();
      if (teamUserIds.length > 0) {
        const { data: partRows } = await supabase
          .from('meeting_participants')
          .select('meeting_id')
          .in('meeting_id', accessibleIds)
          .in('user_id', teamUserIds);
        for (const p of partRows ?? []) involved.add(p.meeting_id as string);
      }
      meetings = applyTeamLens(meetings, involved);
    }
  }

  // U9: the recap is encrypted at rest — decrypt server-side (the key stays in
  // env; the browser never sees it). Prefer the structured recap's `overview`
  // (new meetings); fall back to the legacy markdown blob (old meetings).
  // Resolving the overview here keeps the client's markdown firstLine() from
  // running over a JSON string. DEGRADE on a crypto failure (KMS blip, or a
  // legacy row that can't decrypt under the org key) to a null recap rather than
  // erroring the whole grid. Mirrors the meeting review page.
  //
  // KMS-cost bound: each meeting's recap is a SEPARATE encrypt (its own wrapped
  // data key), so the per-org decrypt cache can't collapse them — decrypting the
  // recap for every meeting would be one live KMS Decrypt per card, per list
  // load. Cap previews to the most-recent RECAP_PREVIEW_LIMIT (the list is sorted
  // newest-first); older cards show "Recap available — open to view" and decrypt
  // on the review page instead.
  const recapByMeeting = new Map<string, string | null>();
  const recapDecryptFailed = new Set<string>();
  const decryptRecaps = Promise.all(
    meetings.slice(0, RECAP_PREVIEW_LIMIT).map(async (m) => {
      try {
        // Prefer the structured overview. When recap_json_enc is present and
        // decrypts, use it (even if the overview is empty) and DO NOT also decrypt
        // the legacy markdown — a second KMS Decrypt would defeat the preview cap.
        // Only on a structured DECRYPT failure do we fall back to the markdown.
        if (m.recap_json_enc !== null) {
          try {
            recapByMeeting.set(
              m.meeting_id,
              structuredRecapOverview(await decryptForOrgFromBytea(orgId, m.recap_json_enc)),
            );
            return;
          } catch (jsonErr) {
            if (!(jsonErr instanceof EnvelopeCryptoError)) throw jsonErr;
            // Structured decrypt failed — fall through to the legacy markdown blob.
          }
        }
        if (m.recap_text_enc !== null) {
          recapByMeeting.set(m.meeting_id, await decryptForOrgFromBytea(orgId, m.recap_text_enc));
        }
      } catch (err) {
        if (err instanceof EnvelopeCryptoError) {
          console.error(`[captures] recap decrypt failed (meetingId=${m.meeting_id}):`, err);
          recapByMeeting.set(m.meeting_id, null);
          recapDecryptFailed.add(m.meeting_id);
        } else {
          throw err;
        }
      }
    }),
  );

  const meetingIds = meetings.map((m) => m.meeting_id);
  const calendarEventIds = meetings
    .map((m) => m.calendar_event_id)
    .filter((id): id is string => id !== null);

  // Title fallback for old rows whose title wasn't denormalized at launch.
  const fetchTitles = (
    calendarEventIds.length > 0
      ? supabase.from('calendar_events').select('id, title').in('id', calendarEventIds)
      : Promise.resolve({ data: [] as Array<{ id: string; title: string }> })
  );

  // Per-meeting aggregates. Prefer the single-round-trip RPC; on any failure
  // (e.g. migration not applied) fall back to JS tallies + no speakers.
  const stats = new Map<string, { answers: number; sources: number; speakers: string[] }>();
  const fetchStats = (async (): Promise<void> => {
    if (meetingIds.length === 0) return;
    const { data: statRows, error: statErr } = await supabase.rpc('capture_card_stats', {
      p_meeting_ids: meetingIds,
    });
    if (statErr === null && Array.isArray(statRows)) {
      for (const r of statRows as Array<{
        meeting_id: string;
        answers_count: number;
        sources_count: number;
        speakers: string[] | null;
      }>) {
        stats.set(r.meeting_id, {
          answers: r.answers_count ?? 0,
          sources: r.sources_count ?? 0,
          speakers: r.speakers ?? [],
        });
      }
    } else {
      // Fallback: tally answers (done syntheses) + sources (live cards) in JS.
      const [synths, cards] = await Promise.all([
        supabase
          .from('syntheses')
          .select('meeting_id')
          .in('meeting_id', meetingIds)
          .eq('status', 'done')
          .is('retracted_at', null),
        supabase.from('cards').select('meeting_id').in('meeting_id', meetingIds).is('retracted_at', null),
      ]);
      const tally = (rows: Array<{ meeting_id: string }> | null, key: 'answers' | 'sources'): void => {
        for (const row of rows ?? []) {
          const cur = stats.get(row.meeting_id) ?? { answers: 0, sources: 0, speakers: [] };
          cur[key] += 1;
          stats.set(row.meeting_id, cur);
        }
      };
      tally(synths.data as Array<{ meeting_id: string }> | null, 'answers');
      tally(cards.data as Array<{ meeting_id: string }> | null, 'sources');
    }
  })();

  // The recap decrypt fan-out, the title fallback, and the stats RPC share no
  // data dependency (titles + stats key off meetingIds, known before decryption)
  // — run them as ONE concurrent wave instead of three serial hops.
  const [, titlesResult] = await Promise.all([decryptRecaps, fetchTitles, fetchStats]);
  const titleByEventId = new Map(
    (titlesResult.data ?? []).map((r) => [r.id as string, (r.title as string) ?? '']),
  );

  const captures: CaptureCard[] = meetings.map((m) => {
    const s = stats.get(m.meeting_id) ?? { answers: 0, sources: 0, speakers: [] };
    const title =
      m.title.length > 0
        ? m.title
        : m.calendar_event_id !== null
          ? (titleByEventId.get(m.calendar_event_id) ?? '')
          : '';
    return {
      meetingId: m.meeting_id,
      title,
      status: m.status,
      startedAtIso: m.started_at,
      endedAtIso: m.ended_at,
      createdAtIso: m.created_at,
      platform: platformFromUrl(m.conference_url),
      summary: recapByMeeting.get(m.meeting_id) ?? null,
      // A recap exists AND its preview either decrypted or wasn't attempted (beyond
      // the cap). A within-window decrypt FAILURE clears this so the card doesn't
      // advertise "Recap available" for content that couldn't be read.
      recapAvailable:
        (m.recap_text_enc !== null || m.recap_json_enc !== null) &&
        !recapDecryptFailed.has(m.meeting_id),
      recapStatus: m.recap_status,
      answersCount: s.answers,
      sourcesCount: s.sources,
      speakers: s.speakers,
      errorCode: m.error_code,
      errorMessage: m.error_message,
    };
  });

  return <CapturesClient captures={captures} orgName={orgName} />;
}
