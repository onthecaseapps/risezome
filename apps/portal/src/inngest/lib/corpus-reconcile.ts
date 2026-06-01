import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Corpus reconciliation core (shared by every source indexer).
 *
 * Given a source's desired item set (docId → content fingerprint), diffs
 * it against what the corpus currently holds for that source and the
 * indexer's owned doc types, and returns which items to (re)index. In
 * full mode — and only on a provably complete fetch — it deletes docs
 * the source no longer has. The FK cascade
 * (docs → doc_chunks → corpus_chunk_embeddings, both `on delete cascade`)
 * cleans chunks + embeddings when a doc row is deleted.
 *
 * Correctness invariants:
 *  - **Type-scoped (R8):** the existing set is read with
 *    `type = ANY(ownedTypes)`, never `source_id` alone. The GitHub repo
 *    and issue indexers share one `source_id`; without the type filter a
 *    file reindex would delete the issue corpus (and vice versa).
 *  - **Prune-gated (R9):** removals are deleted only when
 *    `mode === 'full'` AND `fetchComplete` is true (the desired set is
 *    the complete current source state) AND it isn't a blind
 *    prune-to-zero. A truncated/partial/errored fetch must never prune.
 *  - **Default delta:** an unset mode defaults to `delta` so a missed
 *    caller can only fail toward "doesn't prune," never "wrongly deletes."
 */

export type ReconcileMode = 'delta' | 'full';

export interface DesiredItem {
  /** Stable per-item content fingerprint (file: blob SHA; entity: SHA-256 of chunk text). */
  readonly hash: string;
}

export interface ReconcileInput {
  readonly sourceId: string;
  /** Doc `type` values this indexer owns (e.g. ['file'] or ['issue','pull-request']). */
  readonly ownedTypes: readonly string[];
  /** docId → desired item. */
  readonly desired: ReadonlyMap<string, DesiredItem>;
  readonly mode?: ReconcileMode;
  /**
   * True only when `desired` is the COMPLETE current source state. False
   * for incremental/delta fetches and for any full fetch that truncated
   * or had per-item failures — disables the prune so live docs are never
   * deleted as phantom removals.
   */
  readonly fetchComplete: boolean;
  /**
   * Explicit "the source really is empty" signal. Required for a
   * prune-to-zero (desired empty while docs exist) to proceed; guards
   * against an errored fetch that returned nothing wiping the corpus.
   */
  readonly confirmedEmpty?: boolean;
  /** Delete batch size for the `.in('id', …)` prune (PostgREST URL limit guard). */
  readonly deleteBatchSize?: number;
}

export type ToIndexKind = 'new' | 'changed';

export interface ReconcileResult {
  /** Items to embed + upsert. `changed` items must have chunks cleared first. */
  readonly toIndex: ReadonlyArray<{ readonly docId: string; readonly kind: ToIndexKind }>;
  readonly counts: {
    readonly new: number;
    readonly changed: number;
    readonly unchanged: number;
    readonly removed: number;
  };
  /** Whether the prune actually ran (mode=full, complete fetch, not blind-zero). */
  readonly pruned: boolean;
}

const DEFAULT_DELETE_BATCH = 100;
const EXISTING_PAGE_SIZE = 1000;

interface ExistingRow {
  readonly id: string;
  readonly content_hash: string | null;
}

/**
 * Read every existing doc for (source_id, ownedTypes) — paginated so a
 * large source's existing set is complete (a partial existing read would
 * mis-classify present docs as new and, worse, never see them for prune
 * exclusion).
 */
async function readExisting(
  db: SupabaseClient,
  sourceId: string,
  ownedTypes: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await db
      .from('docs')
      .select('id, content_hash')
      .eq('source_id', sourceId)
      .in('type', ownedTypes as string[])
      .range(from, from + EXISTING_PAGE_SIZE - 1);
    if (error !== null) {
      throw new Error(`corpus-reconcile: read existing failed: ${error.message}`);
    }
    const rows = (data ?? []) as ExistingRow[];
    for (const r of rows) out.set(r.id, r.content_hash);
    if (rows.length < EXISTING_PAGE_SIZE) break;
    from += EXISTING_PAGE_SIZE;
  }
  return out;
}

export async function reconcile(db: SupabaseClient, input: ReconcileInput): Promise<ReconcileResult> {
  const mode: ReconcileMode = input.mode ?? 'delta';
  const existing = await readExisting(db, input.sourceId, input.ownedTypes);

  const toIndex: { docId: string; kind: ToIndexKind }[] = [];
  let unchanged = 0;
  for (const [docId, item] of input.desired) {
    if (!existing.has(docId)) {
      toIndex.push({ docId, kind: 'new' });
    } else if (existing.get(docId) !== item.hash) {
      // Includes the null-hash backfill case (existing hash null → changed).
      toIndex.push({ docId, kind: 'changed' });
    } else {
      unchanged += 1;
    }
  }

  const toDelete: string[] = [];
  for (const id of existing.keys()) {
    if (!input.desired.has(id)) toDelete.push(id);
  }

  // Prune gate (R9): full mode, complete fetch, and not a blind
  // prune-to-zero (an errored fetch returning nothing must not wipe the
  // corpus unless the emptiness is explicitly confirmed).
  const blindZero = input.desired.size === 0 && existing.size > 0 && input.confirmedEmpty !== true;
  const prune = mode === 'full' && input.fetchComplete && !blindZero;

  let removed = 0;
  if (prune && toDelete.length > 0) {
    const batchSize = input.deleteBatchSize ?? DEFAULT_DELETE_BATCH;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      const { error } = await db.from('docs').delete().in('id', batch);
      if (error !== null) {
        // Throw so Inngest retries rather than leaving the corpus
        // half-reconciled with stale rows.
        throw new Error(`corpus-reconcile: delete batch failed: ${error.message}`);
      }
      removed += batch.length;
    }
  }

  const newCount = toIndex.filter((t) => t.kind === 'new').length;
  return {
    toIndex,
    counts: {
      new: newCount,
      changed: toIndex.length - newCount,
      unchanged,
      removed,
    },
    pruned: prune,
  };
}

/**
 * Clear a doc's chunks (and, via cascade, their embeddings) before a
 * changed-item re-index, so a shrunk item leaves no trailing-position
 * orphans. Callers must re-insert chunks + write `content_hash` only
 * AFTER the new chunks/embeddings commit, and must throw (not swallow)
 * an embed failure for a changed item — otherwise the doc is left
 * chunkless with a stale hash and is misread as "unchanged" forever.
 */
export async function clearDocChunks(db: SupabaseClient, docId: string): Promise<void> {
  const { error } = await db.from('doc_chunks').delete().eq('doc_id', docId);
  if (error !== null) {
    throw new Error(`corpus-reconcile: clearDocChunks failed for ${docId}: ${error.message}`);
  }
}
