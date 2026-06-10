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

/**
 * Flatten transcript rows into timestamped, speaker-attributed lines for the
 * model. `payload.startMs` is an ABSOLUTE (epoch-style) ms value, not relative
 * to meeting start — rendering it raw as [mm:ss] produces nonsense like
 * 29677064:14. Normalize each line to elapsed-from-first-utterance (subtract the
 * earliest startMs) so the recap shows real meeting time. This is correct
 * whether the source clock is absolute or already relative.
 */
export function flattenTranscriptLines(rows: readonly TranscriptRow[]): TranscriptLine[] {
  const raw = rows.flatMap((r) => {
    const p = r.payload ?? {};
    const text = r.text;
    if (typeof text !== 'string' || text.length === 0) return [];
    const speaker = typeof p['speaker'] === 'string' ? (p['speaker'] as string) : null;
    const startMs = typeof p['startMs'] === 'number' ? (p['startMs'] as number) : null;
    return [{ speaker, text, startMs }];
  });
  const baseline = raw.reduce<number | null>(
    (min, l) => (l.startMs === null ? min : min === null || l.startMs < min ? l.startMs : min),
    null,
  );
  if (baseline === null) return raw;
  return raw.map((l) => ({
    ...l,
    startMs: l.startMs === null ? null : l.startMs - baseline,
  }));
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

/** The encrypted recap produced by {@link buildEncryptedRecap} — only ciphertext crosses the step boundary. */
export interface BuiltRecap {
  /** `\x<hex>` bytea literal of the KMS-encrypted recap JSON. Safe to persist in Inngest step state. */
  readonly recapJsonEncHex: string;
  readonly generatedAtIso: string;
  readonly recap: 'done' | 'empty';
}

/**
 * Phase 1: load the transcript, mark the recap generating, derive participants,
 * generate the structured recap, and ENCRYPT it — returning only the ciphertext.
 * Idempotent. Split from persistence so the Inngest function can checkpoint the
 * expensive model call: a persist-step retry must never re-bill the Claude call.
 * Only the encrypted blob crosses the step boundary, so no plaintext transcript
 * or recap is written to Inngest's step state.
 */
export async function buildEncryptedRecap(
  service: RecapDb,
  options: GenerateMeetingRecapOptions,
): Promise<BuiltRecap> {
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

  let recap: StructuredRecap;
  let kind: 'done' | 'empty';
  // No transcript → terminal 'done' with a minimal structured placeholder so the
  // review page renders consistently; skip the model call.
  if (lines.length === 0) {
    recap = {
      overview: 'No transcript was captured for this meeting.',
      topics: [],
      decisions: [],
      action_items: [],
      participants: [],
      speakerCount: 0,
    };
    kind = 'empty';
  } else {
    const { participants, speakerCount } = deriveParticipants(rows);
    const narrative = await generate({ transcriptText: buildTranscriptText(lines), title, apiKey });
    recap = { ...narrative, participants, speakerCount };
    kind = 'done';
  }

  // Encrypt under the org's per-org KMS key, stored as a bytea hex-text literal.
  const recapJsonEncHex = await encryptForOrgToBytea(orgId, JSON.stringify(recap));
  return { recapJsonEncHex, generatedAtIso: nowIso(), recap: kind };
}

/**
 * Phase 2: write the pre-encrypted recap. Checks the DB update error and throws
 * so a failed write retries (and never leaves recap_status stuck on 'generating').
 */
export async function persistEncryptedRecap(
  service: RecapDb,
  args: { meetingId: string; orgId: string; recapJsonEncHex: string; generatedAtIso: string },
): Promise<void> {
  const { error } = await service
    .from('meetings')
    .update({
      recap_json_enc: args.recapJsonEncHex,
      recap_json_key_version: CRYPTO_VERSION.KMS_ESDK, // marks the format for rotation
      recap_status: 'done',
      recap_generated_at: args.generatedAtIso,
    })
    .eq('meeting_id', args.meetingId)
    .eq('org_id', args.orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
  if (error !== null) {
    throw new Error(`persistEncryptedRecap failed for meeting=${args.meetingId}: ${error.message}`);
  }
}

/**
 * Convenience orchestrator (build then persist) — used by tests and any
 * non-Inngest caller. The Inngest function itself runs the two phases as
 * separate steps for replay durability (see generateMeetingRecapFn).
 */
export async function generateMeetingRecap(
  service: RecapDb,
  options: GenerateMeetingRecapOptions,
): Promise<{ meetingId: string; recap: 'done' | 'empty' }> {
  const built = await buildEncryptedRecap(service, options);
  await persistEncryptedRecap(service, {
    meetingId: options.meetingId,
    orgId: options.orgId,
    recapJsonEncHex: built.recapJsonEncHex,
    generatedAtIso: built.generatedAtIso,
  });
  return { meetingId: options.meetingId, recap: built.recap };
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
      if (typeof meetingId !== 'string') {
        // Should never happen, but if the failure event shape ever drifts we must
        // not silently leave the recap stuck on 'generating' with no trace.
        console.error(
          '[generate-meeting-recap.onFailure] could not parse meetingId; recap_status NOT flipped to failed',
          event,
        );
        return;
      }
      const service = createServiceRoleClient();
      // service-role-cross-org: onFailure only receives the failed event's meetingId
      // (no org payload); flips a terminal status on a meetingId we ourselves created.
      const { error } = await service
        .from('meetings')
        .update({ recap_status: 'failed' })
        .eq('meeting_id', meetingId);
      if (error !== null) {
        console.error(
          `[generate-meeting-recap.onFailure] failed to flip recap_status for ${meetingId}: ${error.message}`,
        );
      }
    },
    triggers: [{ event: 'risezome/meeting.recap-requested' }],
  },
  async ({ event, step }) => {
    const { meetingId, orgId } = (
      event as unknown as {
        data: { meetingId: string; orgId: string };
      }
    ).data;

    // Defense-in-depth vs duplicate recap-requested events (e.g. a re-delivered
    // webhook): skip when the recap is already done. Legitimate regeneration is
    // unaffected — both regenerate paths flip recap_status to 'generating'
    // BEFORE emitting this event (regenerate-recap-core.ts), so they never
    // read 'done' here.
    const alreadyDone = await step.run('check-already-done', async () => {
      const { data, error } = await createServiceRoleClient()
        .from('meetings')
        .select('recap_status')
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId)
        .maybeSingle();
      if (error !== null) throw new Error(`recap status read failed: ${error.message}`);
      return data?.recap_status === 'done';
    });
    if (alreadyDone) {
      console.info(
        `[generate-meeting-recap] meeting=${meetingId} recap already done; skipping duplicate event`,
      );
      return { meetingId, recap: 'skipped' as const };
    }

    // Two steps so a persist-write retry never re-runs the (billed) Claude call.
    // Only the encrypted recap blob crosses the step boundary — no plaintext.
    const built = await step.run('generate-recap', async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) throw new Error('ANTHROPIC_API_KEY unset');
      return buildEncryptedRecap(createServiceRoleClient(), { meetingId, orgId, apiKey });
    });

    await step.run('persist-recap', () =>
      persistEncryptedRecap(createServiceRoleClient(), {
        meetingId,
        orgId,
        recapJsonEncHex: built.recapJsonEncHex,
        generatedAtIso: built.generatedAtIso,
      }),
    );

    return { meetingId, recap: built.recap };
  },
);
