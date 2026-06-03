import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { backfillMissesForMeeting } from '../lib/knowledge-gaps';

/**
 * One-off backfill: reconstruct knowledge-gap misses for an org's already-ended
 * meetings from the persisted `syntheses` table (refusal / ungrounded
 * retractions), then fan out to the normal assembly job per meeting.
 *
 * Triggered manually (manager action → risezome/gaps.backfill-requested).
 * Idempotent: backfillMissesForMeeting skips utterances that already have a
 * miss row, and the assembly RPC dedupes occurrences, so re-running is safe.
 *
 * Only 'refusal' and 'ungrounded' misses are recoverable — 'no_hits' never
 * created a synthesis row, so those would require replaying retrieval.
 */
export const backfillKnowledgeGapsFn = inngest.createFunction(
  {
    id: 'backfill-knowledge-gaps',
    name: 'Backfill knowledge gaps from past meetings',
    concurrency: [{ key: 'event.data.orgId', limit: 1 }],
    retries: 1,
    triggers: [{ event: 'risezome/gaps.backfill-requested' }],
  },
  async ({ event, step }) => {
    const { orgId } = (event as unknown as { data: { orgId: string } }).data;

    const meetingsWithMisses = await step.run('derive-misses', async () => {
      const service = createServiceRoleClient();
      const { data: meetings, error } = await service
        .from('meetings')
        .select('meeting_id')
        .eq('org_id', orgId)
        .eq('status', 'completed');
      if (error !== null) throw new Error(`backfill load meetings: ${error.message}`);

      const ready: string[] = [];
      let totalMisses = 0;
      for (const m of meetings ?? []) {
        const meetingId = m.meeting_id as string;
        // Re-derive misses for this meeting; also re-fire assembly for any
        // meeting that still has unprocessed misses from a prior partial run.
        const inserted = await backfillMissesForMeeting(service, meetingId, orgId);
        totalMisses += inserted;
        const { count } = await service
          .from('meeting_gap_misses')
          .select('miss_id', { count: 'exact', head: true })
          .eq('meeting_id', meetingId)
          .is('processed_at', null);
        if ((count ?? 0) > 0) ready.push(meetingId);
      }
      return { ready, totalMisses, meetings: (meetings ?? []).length };
    });

    // Fan out to the existing assembly job per meeting (concurrency-keyed,
    // retried, idempotent). Empty list → nothing to assemble.
    if (meetingsWithMisses.ready.length > 0) {
      await step.sendEvent(
        'enqueue-assembly',
        meetingsWithMisses.ready.map((meetingId) => ({
          name: 'risezome/meeting.gaps-requested',
          data: { meetingId, orgId },
        })),
      );
    }

    return {
      orgId,
      meetingsScanned: meetingsWithMisses.meetings,
      missesBackfilled: meetingsWithMisses.totalMisses,
      meetingsEnqueued: meetingsWithMisses.ready.length,
    };
  },
);
