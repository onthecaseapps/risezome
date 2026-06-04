import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { CRYPTO_VERSION, encryptForOrgToBytea } from '@risezome/crypto';
import { transcriptWithText } from '../../../app/_lib/token-crypto';
import { buildTranscriptText, recapMeeting, type TranscriptLine } from '../lib/meeting-recap';

/**
 * Generate a whole-meeting AI recap when a meeting ends (U7). Fired by the
 * recall webhook on the `bot.call_ended` → completed transition. Reads the full
 * transcript from meeting_events, makes one Claude call, and persists the recap
 * onto the meeting. recap_status moves generating → done | failed so the review
 * page can show a "generating…" / "unavailable" state honestly.
 */
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

    const ctx = await step.run('load-transcript', async () => {
      const service = createServiceRoleClient();
      const { data: meeting } = await service
        .from('meetings')
        .select('meeting_id, calendar_event_id')
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId)
        .single();
      if (meeting === null) throw new Error(`meeting not found: org=${orgId} meeting=${meetingId}`);

      let title = 'Meeting';
      if (meeting.calendar_event_id !== null) {
        const { data: ev } = await service
          .from('calendar_events')
          .select('title')
          .eq('id', meeting.calendar_event_id as string)
          .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
          .maybeSingle();
        if (ev !== null && typeof ev.title === 'string' && ev.title.length > 0) title = ev.title;
      }

      // F2: transcript text is encrypted at rest — fetch it decrypted.
      const rows = await transcriptWithText(service, meetingId, orgId);
      const lines: TranscriptLine[] = rows.flatMap((r) => {
        const p = r.payload ?? {};
        const text = r.text;
        if (typeof text !== 'string' || text.length === 0) return [];
        return [
          { speaker: typeof p['speaker'] === 'string' ? (p['speaker'] as string) : null, text },
        ];
      });

      await service
        .from('meetings')
        .update({ recap_status: 'generating' })
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      return { title, transcriptText: buildTranscriptText(lines), hasTranscript: lines.length > 0 };
    });

    // No transcript → terminal 'done' placeholder; skip the model call.
    if (!ctx.hasTranscript) {
      await step.run('finalize-empty', async () => {
        const service = createServiceRoleClient();
        await service
          .from('meetings')
          .update({
            // U9: recap encrypted under the org's per-org KMS key, stored as a
            // bytea hex-text literal. recap_key_version=2 marks the KMS-ESDK format.
            recap_text_enc: await encryptForOrgToBytea(
              orgId,
              'No transcript was captured for this meeting.',
            ),
            recap_key_version: CRYPTO_VERSION.KMS_ESDK,
            recap_status: 'done',
            recap_generated_at: new Date().toISOString(),
          })
          .eq('meeting_id', meetingId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      });
      return { meetingId, recap: 'empty' as const };
    }

    const recap = await step.run('generate', async () => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) throw new Error('ANTHROPIC_API_KEY unset');
      return recapMeeting({ transcriptText: ctx.transcriptText, title: ctx.title, apiKey });
    });

    await step.run('persist', async () => {
      const service = createServiceRoleClient();
      await service
        .from('meetings')
        .update({
          // U9: encrypt under the org's per-org KMS key, stored as bytea hex-text.
          recap_text_enc: await encryptForOrgToBytea(orgId, recap),
          recap_key_version: CRYPTO_VERSION.KMS_ESDK,
          recap_status: 'done',
          recap_generated_at: new Date().toISOString(),
        })
        .eq('meeting_id', meetingId)
        .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    });

    return { meetingId, recap: 'done' as const };
  },
);
