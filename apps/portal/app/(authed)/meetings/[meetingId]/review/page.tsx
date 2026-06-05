import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import { requireAuthedUserWithOrg } from '../../../../_lib/auth';
import { createServerClient } from '../../../../_lib/supabase-server';
import { recordMasterKeyAccessIfNeeded } from '../../../../_lib/meeting-access';
import { decryptForOrgFromBytea, EnvelopeCryptoError } from '@risezome/crypto';
import { transcriptWithText } from '../../../../_lib/transcript';
import type { CardEvent, CardTrigger, TranscriptUtterance } from '@risezome/hud-ui';
import {
  mapSynthesisRow,
  resolveSynthesisAnchors,
  type InitialSynthesis,
  type UtteranceTime,
} from '../_synthesis-seed';
import { ReviewClient, type RecapStatus } from './_client';
import { regenerateRecapAction } from './regenerate-recap-server';
import type { StructuredRecap } from '../../../../../src/inngest/lib/meeting-recap';

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
  const { user, orgId, role } = await requireAuthedUserWithOrg();

  const supabase = await createServerClient();
  const { data: meeting } = await supabase
    .from('meetings')
    .select(
      'meeting_id, org_id, user_id, status, started_at, ended_at, calendar_event_id, recap_text_enc, recap_json_enc, recap_status',
    )
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (meeting === null) notFound();

  // U5: if a super_admin is viewing a meeting only the master key grants them,
  // record an audit row (best-effort; never throws). RLS already granted the row.
  await recordMasterKeyAccessIfNeeded({
    viewer: { userId: user.id, orgId, role },
    meeting: {
      org_id: meeting.org_id as string,
      user_id: meeting.user_id as string,
    },
    meetingId,
  });

  // U9: the recap is encrypted at rest — decrypt server-side (the key stays in
  // env; the browser never sees it). DEGRADE on a crypto failure (KMS blip /
  // deploy-window, or a legacy pre-backfill row that cannot decrypt under the
  // org key): render the page with a null recap rather than a 500.
  const recapEnc = meeting.recap_text_enc as string | null;
  let recapText: string | null = null;
  if (recapEnc !== null) {
    try {
      recapText = await decryptForOrgFromBytea(orgId, recapEnc);
    } catch (err) {
      if (err instanceof EnvelopeCryptoError) {
        console.error(`[review] recap decrypt failed (meetingId=${meetingId}):`, err);
        recapText = null;
      } else {
        throw err;
      }
    }
  }

  // Structured recap (new meetings). Prefer it; fall back to the markdown above
  // for old meetings (recap_json_enc null). DEGRADE to null on a crypto failure
  // or unparseable JSON rather than a 500 — the markdown / muted state renders.
  const recapJsonEnc = meeting.recap_json_enc as string | null;
  let structuredRecap: StructuredRecap | null = null;
  if (recapJsonEnc !== null) {
    try {
      structuredRecap = JSON.parse(await decryptForOrgFromBytea(orgId, recapJsonEnc)) as StructuredRecap;
    } catch (err) {
      if (err instanceof EnvelopeCryptoError || err instanceof SyntaxError) {
        console.error(`[review] structured recap decrypt/parse failed (meetingId=${meetingId}):`, err);
        structuredRecap = null;
      } else {
        throw err;
      }
    }
  }

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
  // F2: transcript text is encrypted at rest — fetch it decrypted (one round-trip).
  const transcriptRows = await transcriptWithText(supabase, meetingId, orgId);
  const initialTranscript: TranscriptUtterance[] = [];
  const utteranceTimes: UtteranceTime[] = [];
  for (const row of transcriptRows) {
    const p = row.payload ?? {};
    const utteranceId = p['utteranceId'];
    const text = row.text;
    if (typeof utteranceId !== 'string' || typeof text !== 'string') continue;
    initialTranscript.push({
      utteranceId,
      text,
      speaker: typeof p['speaker'] === 'string' ? (p['speaker'] as string) : null,
      isFinal: true,
      startMs: typeof p['startMs'] === 'number' ? (p['startMs'] as number) : 0,
      endMs: typeof p['endMs'] === 'number' ? (p['endMs'] as number) : 0,
      revision: typeof p['revision'] === 'number' ? (p['revision'] as number) : 0,
    });
    utteranceTimes.push({ utteranceId, tMs: new Date(row.created_at as string).getTime() });
  }

  // Done syntheses → seed shape, oldest-first (chronological with the transcript).
  const { data: synthRows } = await supabase
    .from('syntheses')
    .select(
      'synthesis_id, source_card_ids, accumulated_text_enc, status, stop_reason, error_code, error_message, citations, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, ttft_ms, latency_ms, trace_id, pinned, pinned_at, trigger_utterance_id, retracted_at, created_at',
    )
    .eq('meeting_id', meetingId)
    .eq('status', 'done')
    .is('retracted_at', null)
    .order('created_at', { ascending: true });
  const rows = (synthRows ?? []) as Record<string, unknown>[];
  // F1: the answer text is encrypted at rest — decrypt into the field the
  // (sync) mappers expect, server-side. Done syntheses always have ciphertext.
  // DEGRADE on a crypto failure: render the page with NO syntheses rather than a
  // 500 (the recap + transcript still render).
  let initialSyntheses: InitialSynthesis[];
  try {
    for (const s of rows) {
      const enc = s['accumulated_text_enc'] as string | null;
      s['accumulated_text'] = enc !== null ? await decryptForOrgFromBytea(orgId, enc) : '';
    }
    initialSyntheses = rows.map((s) => mapSynthesisRow(s));
  } catch (err) {
    if (err instanceof EnvelopeCryptoError) {
      console.error(`[review] synthesis decrypt failed (meetingId=${meetingId}):`, err);
      initialSyntheses = [];
    } else {
      throw err;
    }
  }

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
        typeof s['trigger_utterance_id'] === 'string'
          ? (s['trigger_utterance_id'] as string)
          : null,
      createdAtMs: new Date(s['created_at'] as string).getTime(),
    })),
    utteranceTimes,
  );

  return (
    <ReviewClient
      meetingId={meetingId}
      title={title}
      status={meeting.status as string}
      startedAtIso={meeting.started_at as string | null}
      endedAtIso={meeting.ended_at as string | null}
      recapText={recapText}
      structuredRecap={structuredRecap}
      recapStatus={(meeting.recap_status as RecapStatus) ?? null}
      initialTranscript={initialTranscript}
      initialSyntheses={initialSyntheses}
      initialCards={initialCards}
      anchorMap={anchorMap}
      onRegenerate={regenerateRecapAction}
    />
  );
}
