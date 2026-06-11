import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Corpus reconciliation core (shared by every source indexer).
 *
 * Given a source's desired item set (docId → content fingerprint), diffs
 * it against what the corpus currently holds for that source and the
 * indexer's owned doc types, and returns which items to (re)index. On a
 * provably complete fetch it deletes docs the source no longer has. The
 * FK cascade (docs → doc_chunks → corpus_chunk_embeddings, both
 * `on delete cascade`) cleans chunks + embeddings when a doc row is deleted.
 *
 * Correctness invariants:
 *  - **Type-scoped (R8):** the existing set is read with
 *    `type = ANY(ownedTypes)`, never `source_id` alone. The GitHub repo
 *    and issue indexers share one `source_id`; without the type filter a
 *    file reindex would delete the issue corpus (and vice versa).
 *  - **Prune-gated (R9):** removals are deleted only when `fetchComplete`
 *    is true (the desired set is the complete current source state) AND
 *    it isn't a blind prune-to-zero. A truncated/partial/errored fetch
 *    must never prune.
 *  - **Delta-prune-on-complete-fetch:** the prune is gated on
 *    `fetchComplete`, not on `mode === 'full'`. Content-addressed docIds
 *    (e.g. the repo indexer's `…{path}@{sha}`) mean an edited file
 *    arrives as a NEW docId; if delta mode never pruned, the old
 *    version would accumulate forever (full reindex is not the default
 *    path). When the fetch is complete the desired set IS the source's
 *    whole current state, so pruning its absences is exactly as safe in
 *    delta as in full. Incremental fetchers (e.g. the issues indexer's
 *    `since` cursor) pass `fetchComplete: false` in delta and are
 *    therefore still never pruned on a partial view.
 *  - **Default delta:** an unset mode defaults to `delta`; combined with
 *    the fetchComplete gate a missed caller can only fail toward
 *    "doesn't prune," never "wrongly deletes."
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
  /**
   * Caller intent (kept for telemetry/log parity). The prune is gated on
   * `fetchComplete`, not on mode — see "Delta-prune-on-complete-fetch".
   */
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
  /** Whether the prune actually ran (complete fetch, not blind-zero). */
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
  for (;;) {
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

  // Prune gate (R9): complete fetch, and not a blind prune-to-zero (an
  // errored fetch returning nothing must not wipe the corpus unless the
  // emptiness is explicitly confirmed). Deliberately NOT gated on
  // mode==='full' — see "Delta-prune-on-complete-fetch" above: a complete
  // desired set makes pruning safe in delta too, and content-addressed
  // docIds rot (stale file versions accumulate) if delta never prunes.
  const blindZero = input.desired.size === 0 && existing.size > 0 && input.confirmedEmpty !== true;
  // Sanity backstop: in DELTA mode, refuse a prune that would wipe most of the
  // corpus. A complete fetch SHOULD prune stale docs, but a fetch that silently
  // lost the bulk of its entities (a connector bug the throw-on-partial contract
  // doesn't catch) would look like a giant legitimate deletion. A genuine mass
  // removal still prunes via an explicit `full` reindex. `confirmedEmpty` (the
  // source really is empty) bypasses the backstop.
  const PRUNE_RUNAWAY_MIN = 20;
  const PRUNE_RUNAWAY_FRACTION = 0.5;
  const runawayPrune =
    input.mode === 'delta' &&
    input.confirmedEmpty !== true &&
    existing.size > 0 &&
    toDelete.length >= PRUNE_RUNAWAY_MIN &&
    toDelete.length / existing.size > PRUNE_RUNAWAY_FRACTION;
  const prune = input.fetchComplete && !blindZero && !runawayPrune;
  if (runawayPrune) {
    console.error(
      `[corpus-reconcile] SKIPPED runaway delta prune for source ${input.sourceId}: would delete ${String(toDelete.length)}/${String(existing.size)} docs — run a full reindex to prune this many`,
    );
  }

  let removed = 0;
  if (prune && toDelete.length > 0) {
    const batchSize = input.deleteBatchSize ?? DEFAULT_DELETE_BATCH;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      // Scope the delete to this source (defense-in-depth): doc ids are global
      // text PKs, so without the source filter a future caller / id collision
      // could delete another source's — or another org's — row. The ids come
      // from a source_id-scoped read, so this only ever NARROWS to the same set.
      const { error } = await db.from('docs').delete().eq('source_id', input.sourceId).in('id', batch);
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
 * Abstraction over the corpus WRITE path. Indexers used to write via the
 * service-role REST (PostgREST) client, but that sits behind Supabase's
 * Cloudflare WAF, which 403s chunk bodies containing HTML-like source. The
 * production implementation (`pgCorpusWriter` in corpus-pg.ts) writes over a
 * direct Postgres connection instead; tests inject an in-memory fake.
 *
 * Reads (`reconcile`/`readExisting`) deliberately stay on the REST client —
 * they're small and never trip the WAF.
 */
export interface CorpusWriteClient {
  /**
   * Atomically (re)write one reconciled doc: clear stale chunks on a CHANGED
   * doc, upsert the doc row, then its chunks and embeddings, stamping
   * content_hash. Implementations SHOULD do this in a single transaction;
   * must throw on failure so the Inngest step retries rather than committing
   * a half-written doc that reads as "unchanged" forever (F5).
   */
  writeDoc(w: ReconciledDocWrite): Promise<void>;
  /** Delete a doc's chunks (cascade clears embeddings), org-scoped. */
  clearChunks(docId: string, orgId: string): Promise<void>;
}

/**
 * Clear a doc's chunks (and, via cascade, their embeddings) before a
 * changed-item re-index, so a shrunk item leaves no trailing-position
 * orphans. Org-scoped: doc ids are global text PKs, so the delete is bound
 * to the owning org so a collided id can never clear another org's chunks.
 */
export async function clearDocChunks(
  client: CorpusWriteClient,
  docId: string,
  orgId: string,
): Promise<void> {
  await client.clearChunks(docId, orgId);
}

/**
 * Content fingerprint shared by every entity-keyed indexer (issues, PRs,
 * Trello cards, Jira issues, Confluence pages). The hash is SHA-256 of the
 * joined chunk-input text, so it changes only when the embedded content
 * changes — not on incidental source activity. This must be the exact
 * value a caller stores in `content_hash` and the exact value it passes
 * into `reconcile`'s desired map; centralizing it here prevents the two
 * sides from drifting (which would make every item read as "changed").
 */
export function contentHashFromTexts(texts: readonly string[]): string {
  return createHash('sha256').update(texts.join('\n')).digest('hex');
}

export interface ReconciledDocWrite {
  readonly docId: string;
  readonly kind: ToIndexKind;
  /** Fingerprint to stamp once the doc is whole (must equal the desired hash). */
  readonly hash: string;
  readonly doc: {
    readonly orgId: string;
    readonly sourceId: string;
    readonly source: string;
    readonly type: string;
    readonly title: string;
    readonly url: string | null;
    readonly provenance: 'trusted' | 'untrusted';
    readonly updatedAt: string;
    /** Team ids whose view-policy admits this doc — stamped (denormalized) onto
     *  every chunk + embedding for the query-time `visible_team_ids` filter.
     *  Empty only transiently (pre-backfill); a doc with no admitting team is
     *  not written at all (the union keep-gate). */
    readonly visibleTeamIds: readonly string[];
    /** Optional doc-level metadata (issues/PRs set these; file/card docs leave
     *  them at their column defaults). */
    readonly bodySummary?: string;
    readonly entities?: unknown;
    readonly authors?: unknown;
  };
  readonly chunks: ReadonlyArray<{
    readonly chunkId: string;
    readonly domain: string;
    /** Verbatim chunk body (display + citation matching). */
    readonly text: string;
    /** Contextual-retrieval context for this chunk, '' when none. Folded
     *  into text_fts (and the embedding input) but kept out of `text`. */
    readonly context?: string;
    /** Marks a per-document summary chunk (U6); excluded from content_hash. */
    readonly isSummary?: boolean;
    readonly position: number;
  }>;
  /** pgvector literals, index-aligned with `chunks`. */
  readonly embeddings: readonly string[];
}

/**
 * (Re)write one reconciled doc through the injected write client. The client
 * is responsible for atomicity (the pg implementation wraps the whole write
 * in a transaction): clear stale chunks on a CHANGED doc, upsert the doc row,
 * its chunks and embeddings, and stamp content_hash. Throws on failure so the
 * Inngest step retries rather than committing a half-written doc (F5).
 */
export async function writeReconciledDoc(client: CorpusWriteClient, w: ReconciledDocWrite): Promise<void> {
  if (w.chunks.length !== w.embeddings.length) {
    throw new Error(`writeReconciledDoc: chunk/embedding length mismatch for ${w.docId}`);
  }
  await client.writeDoc(w);
}
