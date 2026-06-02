import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient } from '../../../../_lib/supabase-server';
import type { CardEvent, CardTrigger, TranscriptUtterance } from '@risezome/hud-ui';
import { mapSynthesisRow, type InitialSynthesis } from '../_synthesis-seed';
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

  // Full transcript (finals), ordered.
  const { data: transcriptRows } = await supabase
    .from('meeting_events')
    .select('payload')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .eq('type', 'transcript.data')
    .order('event_id', { ascending: true });
  const initialTranscript: TranscriptUtterance[] = (transcriptRows ?? []).flatMap((row) => {
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

  // Cards (non-retracted) → CardEvent for the synthesis cards' SOURCES, plus a
  // card_id → utterance_id index for the synthesis-anchor fallback.
  const { data: cardRows } = await supabase
    .from('cards')
    .select(
      'card_id, doc_id, source, type, title, snippet, body, score, rank, metadata, surfaced_at, triggered_by, utterance_id, trace_id, url, retracted_at',
    )
    .eq('meeting_id', meetingId)
    .is('retracted_at', null)
    .order('surfaced_at', { ascending: false });
  const cardUtteranceById = new Map<string, string>();
  const initialCards: CardEvent[] = (cardRows ?? []).map((c) => {
    if (typeof c.utterance_id === 'string') cardUtteranceById.set(c.card_id as string, c.utterance_id);
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

  // Anchor map: utteranceId → synthesisId. Prefer the stored trigger; fall back
  // to the first cited card's utterance for rows written before U6. First
  // synthesis to claim an utterance wins.
  const anchorMap: Record<string, string> = {};
  for (const s of rows) {
    const synthesisId = s['synthesis_id'] as string;
    let utteranceId = typeof s['trigger_utterance_id'] === 'string' ? (s['trigger_utterance_id'] as string) : null;
    if (utteranceId === null) {
      const sourceCardIds = (s['source_card_ids'] as string[]) ?? [];
      for (const cardId of sourceCardIds) {
        const uid = cardUtteranceById.get(cardId);
        if (uid !== undefined) {
          utteranceId = uid;
          break;
        }
      }
    }
    if (utteranceId !== null && !(utteranceId in anchorMap)) anchorMap[utteranceId] = synthesisId;
  }

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
