/**
 * Knowledge Gaps — live miss capture (plan U3).
 *
 * Writes one `meeting_gap_misses` row the moment synthesis can't ground an
 * answer. The post-meeting assembly Inngest job (U6) consumes unprocessed
 * rows, dedups them, and folds them into the demand-ranked library.
 *
 * Fire-and-forget: a capture failure must never disrupt the live meeting, so
 * errors are logged and swallowed here.
 *
 * `askerName` is intentionally not captured at this point — the assembly job
 * resolves the speaker from the transcript event matching `utteranceId` when
 * it builds the occurrence (R2).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MissRecord } from '@risezome/engine/gaps';

interface Logger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export async function recordMiss(
  db: SupabaseClient,
  miss: MissRecord,
  logger: Logger,
): Promise<void> {
  try {
    const { error } = await db.from('meeting_gap_misses').insert({
      meeting_id: miss.meetingId,
      org_id: miss.orgId,
      utterance_id: miss.utteranceId,
      verbatim_question: miss.verbatimQuestion,
      reason: miss.reason,
      ...(miss.sourcesSearched !== undefined && { sources_searched: miss.sourcesSearched }),
      ...(miss.intent !== undefined && { intent: miss.intent }),
      ...(miss.entities !== undefined && { entities: miss.entities }),
    });
    if (error !== null) {
      logger.warn(
        { meetingId: miss.meetingId, utteranceId: miss.utteranceId, message: error.message },
        'gap.miss.capture_failed',
      );
      return;
    }
    logger.info(
      { meetingId: miss.meetingId, utteranceId: miss.utteranceId, reason: miss.reason },
      'gap.miss.captured',
    );
  } catch (err) {
    logger.warn(
      { meetingId: miss.meetingId, utteranceId: miss.utteranceId, message: (err as Error).message },
      'gap.miss.capture_failed',
    );
  }
}
