import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient } from '../../../../_lib/supabase-server';
import type { CardEvent, CardTrigger, TranscriptUtterance } from '@risezome/hud-ui';
import {
  mapSynthesisRow,
  resolveSynthesisAnchors,
  type InitialSynthesis,
  type UtteranceTime,
} from '../_synthesis-seed';
import { ReviewClient, type RecapStatus } from './_client';

/**
 * Post-meeting review page (U8). Mirrors the live view: a generated
 * whole-meeting recap, the full transcript with the utterances that triggered
 * an AI summary highlighted, and the same hud-ui synthesis cards (opened by
 * clicking an anchor). Server fetches the static read model; the client wires
 * the reducer + interaction. No Realtime.
 */

interface PageProps {
  params: Promise<{ meetingId: string }>;
}

export default async function ReviewPage(props: PageProps): Promise<ReactElement> {
  const { meetingId } = await props.params;
  const { orgId } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const { data: meeting } = await supabase
    .from('meetings')
    .select(
      'meeting_id, org_id, status, started_at, ended_at, calendar_event_id, recap_text, recap_status',
    )
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (meeting === null) notFound();

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

  // Full transcript (finals), ordered. Capture each utterance's event time so a
  // pre-U6 synthesis (no stored trigger) can be anchored to the question spoken
  // just before it fired.
  const { data: transcriptRows } = await supabase
    .from('meeting_events')
    .select('payload, created_at')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .eq('type', 'transcript.data')
    .order('event_id', { ascending: true });
  const initialTranscript: TranscriptUtterance[] = [];
  const utteranceTimes: UtteranceTime[] = [];
  for (const row of transcriptRows ?? []) {
    const p = (row.payload as Record<string, unknown> | null) ?? {};
    const utteranceId = p['utteranceId'];
    const text = p['text'];
    if (typeof utteranceId !== 'string' || typeof text !== 'string') continue;
    initialTranscript.push({
      utteranceId,
      text,
      speaker: typeof p['speaker'] === 'string' ? (p['speaker'] as string) : null,
      isFinal: true,
      startMs: typeof p['startMs'] === 'number' ? (p['startMs'] as number) : 0,
      revision: typeof p['revision'] === 'number' ? (p['revision'] as number) : 0,
    });
    utteranceTimes.push({ utteranceId, tMs: new Date(row.created_at as string).getTime() });
  }

  // Done syntheses → seed shape, oldest-first (chronological with the transcript).
  const { data: synthRows } = await supabase
    .from('syntheses')
    .select(
      'synthesis_id, source_card_ids, accumulated_text, status, stop_reason, error_code, error_message, citations, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ttft_ms, latency_ms, trace_id, pinned, pinned_at, trigger_utterance_id, retracted_at, created_at',
    )
    .eq('meeting_id', meetingId)
    .eq('status', 'done')
    .is('retracted_at', null)
    .order('created_at', { ascending: true });
  const rows = (synthRows ?? []) as Record<string, unknown>[];
  const initialSyntheses: InitialSynthesis[] = rows.map((s) => mapSynthesisRow(s));

  // Cards the syntheses cite → CardEvent for the cards' SOURCES list. Fetched
  // by id REGARDLESS of retraction: a cited card is frequently retracted by
  // dedup churn during the meeting, but the completed answer still needs to
  // render its source (otherwise "grounded in 0 sources" with dead chips —
  // mirrors the live page keeping cited cards in reducer state). On review,
  // cards appear only as a synthesis's sources, so non-cited cards are skipped.
  const citedCardIds = Array.from(
    new Set(rows.flatMap((s) => (s['source_card_ids'] as string[] | null) ?? [])),
  );
  const cardRows =
    citedCardIds.length > 0
      ? (
          await supabase
            .from('cards')
            .select(
              'card_id, doc_id, source, type, title, snippet, body, score, rank, metadata, surfaced_at, triggered_by, utterance_id, trace_id, url',
            )
            .eq('meeting_id', meetingId)
            .in('card_id', citedCardIds)
        ).data
      : [];
  const initialCards: CardEvent[] = (cardRows ?? []).map((c) => {
    return {
      cardId: c.card_id as string,
      docId: (c.doc_id as string | null) ?? '',
      source: c.source as string,
      type: c.type as string,
      title: c.title as string,
      snippet: c.snippet as string,
      body: (c.body as string | null) ?? (c.snippet as string),
      score: c.score as number,
      rank: c.rank as number,
      metadata: (c.metadata as Record<string, unknown>) ?? {},
      surfacedAt: new Date(c.surfaced_at as string).getTime(),
      triggeredBy: c.triggered_by as CardTrigger,
      ...(c.utterance_id !== null ? { utteranceId: c.utterance_id as string } : {}),
      traceId: c.trace_id as string,
      ...(c.url !== null ? { url: c.url as string } : {}),
    };
  });

  // Anchor map: utteranceId → synthesisId. Prefer the stored trigger (U6);
  // fall back to the utterance spoken just before the synthesis fired (by time)
  // for pre-U6 rows.
  const anchorMap = resolveSynthesisAnchors(
    rows.map((s) => ({
      synthesisId: s['synthesis_id'] as string,
      triggerUtteranceId:
        typeof s['trigger_utterance_id'] === 'string' ? (s['trigger_utterance_id'] as string) : null,
      createdAtMs: new Date(s['created_at'] as string).getTime(),
    })),
    utteranceTimes,
  );

  return (
    <ReviewClient
      title={title}
      status={meeting.status as string}
      startedAtIso={meeting.started_at as string | null}
      endedAtIso={meeting.ended_at as string | null}
      recapText={(meeting.recap_text as string | null) ?? null}
      recapStatus={(meeting.recap_status as RecapStatus) ?? null}
      initialTranscript={initialTranscript}
      initialSyntheses={initialSyntheses}
      initialCards={initialCards}
      anchorMap={anchorMap}
    />
  );
}
