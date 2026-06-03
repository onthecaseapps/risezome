import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { VoyageEmbedder } from '@risezome/engine/embed';
import { assembleKnowledgeGaps, makeSectionNamer } from '../lib/knowledge-gaps';

/**
 * Assemble knowledge gaps when a meeting ends (U6/U7). Fired by the recall
 * webhook on the `bot.call_ended` → completed transition, alongside the recap
 * job. Embeds + dedups this meeting's misses, folds them into the demand-ranked
 * library via the org-locked assemble_gap_occurrence_group RPC, re-clusters
 * sections, and notifies assignees of any resurfaced gaps.
 *
 * Idempotent: occurrences are unique on (meeting_id, utterance_id), and misses
 * are marked processed only after everything commits — a retry re-inserts
 * nothing and never double-counts frequency.
 */
export const assembleKnowledgeGapsFn = inngest.createFunction(
  {
    id: 'assemble-knowledge-gaps',
    name: 'Assemble knowledge gaps from a meeting',
    concurrency: [{ key: 'event.data.meetingId', limit: 1 }],
    retries: 3,
    onFailure: ({ event }) => {
      // Retries exhausted: the meeting's misses stay unprocessed (processed_at
      // is null) and won't re-fire on their own. Surface it so an exhausted
      // assembly is observable rather than silently dropped from the library.
      const original = (event as unknown as { data: { event?: { data?: { meetingId?: string } } } }).data;
      const meetingId = original.event?.data?.meetingId;
      console.error(`[knowledge-gaps] assembly failed after retries for meeting=${String(meetingId)}`);
    },
    triggers: [{ event: 'risezome/meeting.gaps-requested' }],
  },
  async ({ event, step }) => {
    const { meetingId, orgId } = (event as unknown as {
      data: { meetingId: string; orgId: string };
    }).data;

    return step.run('assemble', async () => {
      const voyageKey = process.env['VOYAGE_API_KEY'];
      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      if (voyageKey === undefined || voyageKey.length === 0) throw new Error('VOYAGE_API_KEY unset');
      if (anthropicKey === undefined || anthropicKey.length === 0) throw new Error('ANTHROPIC_API_KEY unset');

      const service = createServiceRoleClient();
      const embedder = new VoyageEmbedder({ apiKey: voyageKey });
      const sectionNamer = makeSectionNamer(anthropicKey);

      return assembleKnowledgeGaps({ service, embedder, sectionNamer, meetingId, orgId });
    });
  },
);
