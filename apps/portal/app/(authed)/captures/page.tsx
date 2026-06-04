import type { ReactElement } from 'react';
import { decryptForOrgFromBytea, EnvelopeCryptoError } from '@risezome/crypto';
import { requireAuthedUserWithOrg } from '../../_lib/auth';
import { createServerClient } from '../../_lib/supabase-server';
import { CapturesClient, type CaptureCard, type CapturePlatform } from './_client';
import { toPrivacyLevel } from '../../_lib/privacy-levels';

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

function platformFromUrl(url: string | null): CapturePlatform {
  if (url === null) return 'other';
  const u = url.toLowerCase();
  if (u.includes('zoom.us') || u.includes('zoom.com')) return 'zoom';
  if (u.includes('meet.google.com')) return 'meet';
  if (u.includes('teams.microsoft') || u.includes('teams.live')) return 'teams';
  return 'other';
}

export default async function CapturesPage(): Promise<ReactElement> {
  const { orgId, orgName } = await requireAuthedUserWithOrg();
  const supabase = await createServerClient();

  const { data: meetingRows } = await supabase
    .from('meetings')
    .select(
      'meeting_id, status, started_at, ended_at, error_code, error_message, calendar_event_id, title, conference_url, recap_text_enc, recap_status, privacy_level, created_at',
    )
    .eq('org_id', orgId)
    .in('status', ['completed', 'failed'])
    .order('created_at', { ascending: false })
    .limit(100);

  const meetings = (meetingRows ?? []) as Array<{
    meeting_id: string;
    status: 'completed' | 'failed';
    started_at: string | null;
    ended_at: string | null;
    error_code: string | null;
    error_message: string | null;
    calendar_event_id: string | null;
    title: string;
    conference_url: string | null;
    recap_text_enc: string | null;
    recap_status: 'generating' | 'done' | 'failed' | null;
    privacy_level: string | null;
    created_at: string;
  }>;

  // U9: the recap is encrypted at rest — decrypt server-side (the key stays in
  // env; the browser never sees it). DEGRADE on a crypto failure (KMS blip, or
  // a legacy row that can't decrypt under the org key) to a null recap rather
  // than erroring the whole grid. Mirrors the meeting review page.
  const recapByMeeting = new Map<string, string | null>();
  await Promise.all(
    meetings.map(async (m) => {
      if (m.recap_text_enc === null) return;
      try {
        recapByMeeting.set(m.meeting_id, await decryptForOrgFromBytea(orgId, m.recap_text_enc));
      } catch (err) {
        if (err instanceof EnvelopeCryptoError) {
          console.error(`[captures] recap decrypt failed (meetingId=${m.meeting_id}):`, err);
          recapByMeeting.set(m.meeting_id, null);
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
  const titlesResult =
    calendarEventIds.length > 0
      ? await supabase.from('calendar_events').select('id, title').in('id', calendarEventIds)
      : { data: [] as Array<{ id: string; title: string }> };
  const titleByEventId = new Map(
    (titlesResult.data ?? []).map((r) => [r.id as string, (r.title as string) ?? '']),
  );

  // Per-meeting aggregates. Prefer the single-round-trip RPC; on any failure
  // (e.g. migration not applied) fall back to JS tallies + no speakers.
  const stats = new Map<string, { answers: number; sources: number; speakers: string[] }>();
  if (meetingIds.length > 0) {
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
  }

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
      privacyLevel: toPrivacyLevel(m.privacy_level),
      summary: recapByMeeting.get(m.meeting_id) ?? null,
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
