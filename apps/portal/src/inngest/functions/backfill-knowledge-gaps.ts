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

    // Paged: PostgREST caps un-ranged reads at 1000 rows, which would silently
    // skip the rest of an org's completed meetings.
    const meetingIds = (await step.run('load-meetings', async () => {
      const service = createServiceRoleClient();
      const PAGE_SIZE = 1000;
      const ids: string[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: meetings, error } = await service
          .from('meetings')
          .select('meeting_id')
          .eq('org_id', orgId)
          .eq('status', 'completed')
          .order('meeting_id', { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error !== null) throw new Error(`backfill load meetings: ${error.message}`);
        const rows = meetings ?? [];
        for (const m of rows) ids.push(m.meeting_id as string);
        if (rows.length < PAGE_SIZE) break;
      }
      return ids;
    })) as string[];

    // Derive misses in chunked steps so progress checkpoints — one step over
    // every meeting (a transcript KMS decrypt each) flaps on the step timeout
    // and restarts from meeting 0. backfillMissesForMeeting itself pre-filters
    // on retracted syntheses BEFORE any transcript decrypt, so meetings with
    // nothing to recover stay cheap.
    const CHUNK_SIZE = 10;
    const ready: string[] = [];
    let totalMisses = 0;
    for (let chunkIndex = 0; chunkIndex * CHUNK_SIZE < meetingIds.length; chunkIndex += 1) {
      const chunk = meetingIds.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
      const res = (await step.run(`derive-misses-${chunkIndex}`, async () => {
        const service = createServiceRoleClient();
        const chunkReady: string[] = [];
        let misses = 0;
        for (const meetingId of chunk) {
          // Re-derive misses for this meeting; also re-fire assembly for any
          // meeting that still has unprocessed misses from a prior partial run.
          const inserted = await backfillMissesForMeeting(service, meetingId, orgId);
          misses += inserted;
          const { count } = await service
            .from('meeting_gap_misses')
            .select('miss_id', { count: 'exact', head: true })
            .eq('meeting_id', meetingId)
            .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
            .is('processed_at', null);
          if ((count ?? 0) > 0) chunkReady.push(meetingId);
        }
        return { ready: chunkReady, misses };
      })) as { ready: string[]; misses: number };
      ready.push(...res.ready);
      totalMisses += res.misses;
    }

    // Fan out to the existing assembly job per meeting (concurrency-keyed,
    // retried, idempotent). Empty list → nothing to assemble.
    if (ready.length > 0) {
      await step.sendEvent(
        'enqueue-assembly',
        ready.map((meetingId) => ({
          name: 'risezome/meeting.gaps-requested',
          data: { meetingId, orgId },
        })),
      );
    }

    return {
      orgId,
      meetingsScanned: meetingIds.length,
      missesBackfilled: totalMisses,
      meetingsEnqueued: ready.length,
    };
  },
);
