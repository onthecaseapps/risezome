import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';

/**
 * Purge the ingested content of disconnected sources (security U7 / S7).
 *
 * When a source is disconnected (GitHub App uninstall soft-flags
 * `sources.status = 'removed'`; the same applies to Trello/Atlassian disconnects)
 * the customer's indexed code/doc content + embeddings previously persisted
 * FOREVER — a retention liability and a larger blast radius for any future DB
 * compromise.
 *
 * This cron hard-deletes `sources` rows that have been `removed` for longer than
 * a grace window. Deleting the `sources` row cascades through the FK chain
 * (`docs` → `doc_chunks` → `corpus_chunk_embeddings`, and `summary_chunks`), so
 * all of that source's content and vectors are purged. The grace window gives a
 * recovery margin for an accidental disconnect/reconnect before the content is
 * irreversibly removed.
 *
 * Idempotent: a row already deleted simply isn't matched on the next run. Uses
 * the service-role client (RLS bypass) and runs daily.
 */

const DEFAULT_GRACE_DAYS = 7;

export function purgeGraceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env['RISEZOME_SOURCE_PURGE_GRACE_DAYS'];
  const days = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const effective = Number.isFinite(days) && days >= 0 ? days : DEFAULT_GRACE_DAYS;
  return effective * 24 * 60 * 60 * 1000;
}

interface PurgeRows {
  data: { id: string }[] | null;
  error: { message: string } | null;
}

/** Minimal structural view of the delete chain the purge needs. */
export interface PurgeDb {
  from(table: string): {
    delete(): {
      eq(
        col: string,
        value: unknown,
      ): {
        lt(
          col: string,
          value: unknown,
        ): {
          select(cols: string): Promise<PurgeRows>;
        };
      };
    };
  };
}

export interface PurgeResult {
  purged: number;
}

/**
 * Core purge logic, separated from the Inngest wrapper so it's directly
 * testable. Deletes sources `removed` before the cutoff; the FK cascade clears
 * each source's docs, chunks, and embeddings.
 */
export async function purgeRemovedSources(
  db: PurgeDb,
  opts: { nowMs: number; graceMs: number },
): Promise<PurgeResult> {
  const cutoff = new Date(opts.nowMs - opts.graceMs).toISOString();
  const res = await db
    .from('sources')
    .delete()
    .eq('status', 'removed')
    .lt('removed_at', cutoff)
    .select('id');
  if (res.error !== null) {
    throw new Error(`purge removed sources failed: ${res.error.message}`);
  }
  return { purged: (res.data ?? []).length };
}

export const purgeRemovedSourcesCron = inngest.createFunction(
  {
    id: 'purge-removed-sources-cron',
    name: 'Purge disconnected sources content (daily)',
    retries: 1,
    triggers: [{ cron: '0 4 * * *' }],
  },
  async () => {
    const service = createServiceRoleClient() as unknown as PurgeDb;
    return purgeRemovedSources(service, { nowMs: Date.now(), graceMs: purgeGraceMs() });
  },
);
