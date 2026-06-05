import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { CRYPTO_VERSION, encryptForOrgToBytea } from '@risezome/crypto';
import { transcriptWithText, type TranscriptRow } from '../../../app/_lib/transcript';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildTranscriptText,
  recapMeetingStructured,
  type RecapParticipant,
  type StructuredRecap,
  type StructuredRecapNarrative,
  type TranscriptLine,
} from '../lib/meeting-recap';

/**
 * Generate a whole-meeting AI recap when a meeting ends. Fired by the recall
 * webhook on the `bot.call_ended` → completed transition (and by the review
 * page's Regenerate control). Reads the full transcript from meeting_events,
 * makes one structured Claude call (forced tool-use → typed JSON), derives the
 * participant list + speaker count from transcript speaker labels, and persists
 * the recap (encrypted) onto the meeting. recap_status moves generating → done |
 * failed so the review page can show a "generating…" / "unavailable" state.
 */

/** Minimal Supabase surface the orchestrator needs (loosely typed for tests). */
export type RecapDb = Pick<ReturnType<typeof createServiceRoleClient>, 'from'>;

type RecapGenerator = (opts: {
  readonly transcriptText: string;
  readonly title: string;
  readonly apiKey: string;
}) => Promise<StructuredRecapNarrative>;

type TranscriptReader = (db: RecapDb, meetingId: string, orgId: string) => Promise<TranscriptRow[]>;

export interface GenerateMeetingRecapOptions {
  readonly meetingId: string;
  readonly orgId: string;
  readonly apiKey: string;
  /** Injectable for tests; defaults to the structured Anthropic call. */
  readonly generate?: RecapGenerator;
  /** Injectable for tests; defaults to the per-org KMS transcript decrypt. */
  readonly transcriptReader?: TranscriptReader;
  /** Injectable for tests; defaults to wall-clock. */
  readonly nowIso?: () => string;
}

/** Flatten transcript rows into timestamped, speaker-attributed lines for the model. */
export function flattenTranscriptLines(rows: readonly TranscriptRow[]): TranscriptLine[] {
  return rows.flatMap((r) => {
    const p = r.payload ?? {};
    const text = r.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const speaker = typeof p['speaker'] === 'string' ? (p['speaker'] as string) : null;
    const startMs = typeof p['startMs'] === 'number' ? (p['startMs'] as number) : null;
    return [{ speaker, text, startMs }];
  });
}

/**
 * Derive the participant list + speaker count from distinct, non-empty transcript
 * speaker labels (the same source capture_card_stats aggregates). Named attendees
 * exist only when Recall supplied `participant.name`; local-audio meetings have a
 * null speaker → `participants: []` / `speakerCount: 0` (the accepted fallback).
 */
export function deriveParticipants(rows: readonly TranscriptRow[]): {
  participants: RecapParticipant[];
  speakerCount: number;
} {
  const seen: string[] = [];
  for (const r of rows) {
    const speaker = (r.payload ?? {})['speaker'];
    if (typeof speaker !== 'string') continue;
    const name = speaker.trim();
    if (name.length === 0 || seen.includes(name)) continue;
    seen.push(name);
  }
  return { participants: seen.map((name) => ({ name })), speakerCount: seen.length };
}

async function persistRecap(
  service: RecapDb,
  meetingId: string,
  orgId: string,
  recap: StructuredRecap,
  generatedAtIso: string,
): Promise<void> {
  await service
    .from('meetings')
    .update({
      // Encrypt under the org's per-org KMS key, stored as a bytea hex-text
      // literal. recap_json_key_version=KMS_ESDK marks the format for rotation.
      recap_json_enc: await encryptForOrgToBytea(orgId, JSON.stringify(recap)),
      recap_json_key_version: CRYPTO_VERSION.KMS_ESDK,
      recap_status: 'done',
      recap_generated_at: generatedAtIso,
    })
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
}

/**
 * Pure orchestrator (testable without the Inngest harness). Loads the transcript,
 * marks the recap generating, derives participants, generates the structured
 * recap, and persists the encrypted JSON. Idempotent — safe to re-run on retry.
 */
export async function generateMeetingRecap(
  service: RecapDb,
  options: GenerateMeetingRecapOptions,
): Promise<{ meetingId: string; recap: 'done' | 'empty' }> {
  const { meetingId, orgId, apiKey } = options;
  const generate = options.generate ?? recapMeetingStructured;
  const readTranscript: TranscriptReader =
    options.transcriptReader ?? ((db, m, o) => transcriptWithText(db as SupabaseClient, m, o));
  const nowIso = options.nowIso ?? (() => new Date().toISOString());

  const { data: meeting } = await service
    .from('meetings')
    .select('meeting_id, calendar_event_id')
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId)
    .single();
  if (meeting === null) throw new Error(`meeting not found: org=${orgId} meeting=${meetingId}`);

  let title = 'Meeting';
  const calendarEventId = (meeting as { calendar_event_id: string | null }).calendar_event_id;
  if (calendarEventId !== null) {
    const { data: ev } = await service
      .from('calendar_events')
      .select('title')
      .eq('id', calendarEventId)
      .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      .maybeSingle();
    if (ev !== null && typeof ev.title === 'string' && ev.title.length > 0) title = ev.title;
  }

  // Transcript text is encrypted at rest — fetch it decrypted.
  const rows = await readTranscript(service, meetingId, orgId);
  const lines = flattenTranscriptLines(rows);

  await service
    .from('meetings')
    .update({ recap_status: 'generating' })
    .eq('meeting_id', meetingId)
    .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly

  // No transcript → terminal 'done' with a minimal structured placeholder so the
  // new review page renders consistently; skip the model call.
  if (lines.length === 0) {
    const placeholder: StructuredRecap = {
      overview: 'No transcript was captured for this meeting.',
      topics: [],
      decisions: [],
      action_items: [],
      participants: [],
      speakerCount: 0,
    };
    await persistRecap(service, meetingId, orgId, placeholder, nowIso());
    return { meetingId, recap: 'empty' };
  }

  const { participants, speakerCount } = deriveParticipants(rows);
  const narrative = await generate({
    transcriptText: buildTranscriptText(lines),
    title,
    apiKey,
  });
  const recap: StructuredRecap = { ...narrative, participants, speakerCount };

  await persistRecap(service, meetingId, orgId, recap, nowIso());
  return { meetingId, recap: 'done' };
}

export const generateMeetingRecapFn = inngest.createFunction(
  {
    id: 'generate-meeting-recap',
    name: 'Generate a whole-meeting AI recap',
    concurrency: [{ key: 'event.data.meetingId', limit: 1 }],
    retries: 3,
    onFailure: async ({ event }) => {
      // Exhausted retries: mark the recap failed so the review page stops
      // showing "generating…". The original event is nested under data.event.
      const original = (event as unknown as { data: { event?: { data?: { meetingId?: string } } } })
        .data;
      const meetingId = original.event?.data?.meetingId;
      if (typeof meetingId !== 'string') return;
      const service = createServiceRoleClient();
      // service-role-cross-org: onFailure only receives the failed event's meetingId
      // (no org payload); flips a terminal status on a meetingId we ourselves created.
      await service.from('meetings').update({ recap_status: 'failed' }).eq('meeting_id', meetingId);
    },
    triggers: [{ event: 'risezome/meeting.recap-requested' }],
  },
  async ({ event, step }) => {
    const { meetingId, orgId } = (
      event as unknown as {
        data: { meetingId: string; orgId: string };
      }
    ).data;

    return step.run('generate-recap', async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) throw new Error('ANTHROPIC_API_KEY unset');
      return generateMeetingRecap(createServiceRoleClient(), { meetingId, orgId, apiKey });
    });
  },
);
