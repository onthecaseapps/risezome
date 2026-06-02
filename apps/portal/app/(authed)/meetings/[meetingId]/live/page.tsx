import type { ReactElement } from 'react';
import { notFound, redirect } from 'next/navigation';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient } from '../../../../_lib/supabase-server';
import { LiveMeetingClient } from './_client';
import type { CardEvent, CardTrigger, TranscriptUtterance } from '@risezome/hud-ui';
import { mapSynthesisRow, type InitialSynthesis } from '../_synthesis-seed';

export type { InitialSynthesis };

/**
 * Live meeting page. Server renders the initial state from DB; the
 * client component subscribes to Realtime in U11b. For now: static
 * snapshot on page load, refresh to update.
 *
 * Status-driven rendering:
 *   launching | awaiting_recall | joining | waiting_room → joining shell
 *   recording                                            → full HUD
 *   completed                                            → redirect to /review (placeholder)
 *   failed                                               → diagnostic banner
 */

interface PageProps {
  params: Promise<{ meetingId: string }>;
}

export default async function LiveMeetingPage(props: PageProps): Promise<ReactElement> {
  const { meetingId } = await props.params;
  const { orgId } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const { data: meeting } = await supabase
    .from('meetings')
    .select(
      'meeting_id, org_id, user_id, status, recall_bot_id, error_code, error_message, started_at, ended_at, calendar_event_id',
    )
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (meeting === null) {
    notFound();
  }

  const status = meeting.status as
    | 'launching'
    | 'awaiting_recall'
    | 'joining'
    | 'waiting_room'
    | 'recording'
    | 'completed'
    | 'failed';

  if (status === 'completed') {
    // Meeting wrapped — flip to the post-meeting review surface where
    // we render cards/syntheses statically (no Realtime). The redirect
    // is via the same /meetings/[id] path tree so the back button gets
    // the user out of the in-meeting context cleanly.
    redirect(`/meetings/${meetingId}/review`);
  }

  // Pull the calendar event for context (title, conference URL) if available.
  let title = 'Meeting';
  if (meeting.calendar_event_id !== null) {
    const { data: calEvent } = await supabase
      .from('calendar_events')
      .select('title')
      .eq('id', meeting.calendar_event_id)
      .maybeSingle();
    if (calEvent !== null && typeof calEvent.title === 'string' && calEvent.title.length > 0) {
      title = calEvent.title;
    }
  }

  // Cards + syntheses + transcript are only relevant in the recording state.
  // Skip the fetch for joining/launching so the joining shell renders fast.
  let initialCards: CardEvent[] = [];
  let initialSyntheses: InitialSynthesis[] = [];
  let initialTranscript: TranscriptUtterance[] = [];

  if (status === 'recording') {
    const { data: cardRows } = await supabase
      .from('cards')
      .select(
        'card_id, doc_id, source, type, title, snippet, body, score, rank, metadata, surfaced_at, triggered_by, utterance_id, trace_id, url, pinned, retracted_at',
      )
      .eq('meeting_id', meetingId)
      .order('surfaced_at', { ascending: false });
    initialCards = (cardRows ?? [])
      .filter((c) => c.retracted_at === null)
      .map((c) => ({
        cardId: c.card_id as string,
        docId: (c.doc_id as string | null) ?? '',
        source: c.source as string,
        type: c.type as string,
        title: c.title as string,
        snippet: c.snippet as string,
        // body is non-null in new rows; backfilled to snippet for old
        // rows. Fall back to snippet at the type boundary too, just
        // in case a row predates the backfill migration.
        body: (c.body as string | null) ?? (c.snippet as string),
        score: c.score as number,
        rank: c.rank as number,
        metadata: (c.metadata as Record<string, unknown>) ?? {},
        surfacedAt: new Date(c.surfaced_at as string).getTime(),
        triggeredBy: c.triggered_by as CardTrigger,
        ...(c.utterance_id !== null ? { utteranceId: c.utterance_id as string } : {}),
        traceId: c.trace_id as string,
        ...(c.url !== null ? { url: c.url as string } : {}),
      }));

    const { data: synthRows } = await supabase
      .from('syntheses')
      .select(
        'synthesis_id, source_card_ids, accumulated_text, status, stop_reason, error_code, error_message, citations, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ttft_ms, latency_ms, trace_id, retracted_at, created_at, pinned, pinned_at',
      )
      .eq('meeting_id', meetingId)
      .order('created_at', { ascending: false });
    initialSyntheses = (synthRows ?? [])
      .filter((s) => s.retracted_at === null)
      .map((s) => mapSynthesisRow(s as Record<string, unknown>));

    // Seed the prior transcript (finals only) so a reload mid-meeting restores
    // what was already said; the live channel + reconnect-replay keep it
    // current. Partials are transient and intentionally not seeded.
    const { data: transcriptRows } = await supabase
      .from('meeting_events')
      .select('payload')
      .eq('meeting_id', meetingId)
      .eq('org_id', orgId)
      .eq('type', 'transcript.data')
      .order('event_id', { ascending: true });
    initialTranscript = (transcriptRows ?? []).flatMap((row): TranscriptUtterance[] => {
      const p = (row.payload as Record<string, unknown> | null) ?? {};
      const utteranceId = p['utteranceId'];
      const text = p['text'];
      if (typeof utteranceId !== 'string' || typeof text !== 'string') return [];
      return [
        {
          utteranceId,
          text,
          speaker: typeof p['speaker'] === 'string' ? (p['speaker'] as string) : null,
          isFinal: true,
          startMs: typeof p['startMs'] === 'number' ? (p['startMs'] as number) : 0,
          revision: typeof p['revision'] === 'number' ? (p['revision'] as number) : 0,
        },
      ];
    });
  }

  return (
    <LiveMeetingClient
      meetingId={meetingId}
      orgId={orgId}
      status={status}
      title={title}
      errorCode={meeting.error_code as string | null}
      errorMessage={meeting.error_message as string | null}
      startedAtIso={meeting.started_at as string | null}
      initialCards={initialCards}
      initialSyntheses={initialSyntheses}
      initialTranscript={initialTranscript}
    />
  );
}

