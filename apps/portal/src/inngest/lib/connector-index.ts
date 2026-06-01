import { VoyageEmbedder, EmbeddingRateLimitError, type EmbeddingDomain } from '@risezome/engine/embed';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import type { IndexMode } from '../client';
import {
  reconcile,
  writeReconciledDoc,
  contentHashFromTexts,
  type ReconcileResult,
  type ToIndexKind,
} from './corpus-reconcile';

/**
 * Shared reconcile orchestrator for the full-fetch connectors (Trello,
 * Jira, Confluence). They have no cheap incremental API, so every run
 * fetches the complete entity set; reconciliation gives us the three
 * required behaviors anyway:
 *
 *   - unchanged → skipped (the big win: these used to re-embed everything)
 *   - changed   → chunks cleared + re-embedded atomically
 *   - removed   → pruned in full mode (delta keeps them)
 *
 * The connector supplies only what differs: how to fetch its entities, how
 * to turn one entity into a prepared doc (id + chunk inputs + metadata),
 * and how to recognize its auth-revoked error. Everything correctness- or
 * atomicity-sensitive lives here and in `corpus-reconcile`, so the three
 * connectors can't drift.
 *
 * Counters: each connector owns its `sources` row outright, so it writes
 * its own counters (no GitHub-style shared-counter détente). Because the
 * prepare phase chunks every entity to fingerprint it, the full chunk
 * total is known without an extra query — `indexed_files`/`chunk_count`
 * reflect the whole current source, not just what was re-embedded.
 */

const PREPARE_BATCH = 8;
const EMBED_BATCH = 5;

export interface PreparedDoc {
  readonly docId: string;
  readonly title: string;
  readonly url: string | null;
  readonly updatedAt: string;
  readonly chunks: ReadonlyArray<{ readonly text: string; readonly domain: EmbeddingDomain }>;
}

/**
 * Loose structural view of Inngest's `step`. Its real `run` returns a
 * `Jsonify<…>`-transformed type that isn't assignable to a `Promise<T>`
 * generic, so we type the return as `Promise<unknown>` (the orchestrator
 * never needs the Jsonify guarantee) and annotate each call's result at
 * the use site. This keeps the orchestrator independent of Inngest's
 * generic step typing while staying type-checked internally.
 */
interface StepLike {
  run(id: string, fn: () => Promise<unknown>): Promise<unknown>;
}

export interface ConnectorIndexConfig<E> {
  readonly step: StepLike;
  readonly orgId: string;
  readonly sourceId: string;
  readonly mode: IndexMode | undefined;
  /** docs.source enum value, e.g. 'trello' | 'jira' | 'confluence'. */
  readonly source: string;
  /** doc.type this connector owns, e.g. 'card' | 'issue' | 'page'. */
  readonly docType: string;
  readonly provenance: 'trusted' | 'untrusted';
  /** Fetch the COMPLETE entity set. Must throw (not truncate) on partial failure. */
  readonly fetchEntities: () => Promise<readonly E[]>;
  /** Build a prepared doc for one entity (may fetch comments → may throw auth error). Null = no indexable content. */
  readonly prepare: (entity: E) => Promise<PreparedDoc | null>;
  readonly isAuthError: (err: unknown) => boolean;
  readonly reconnectMessage: string;
}

export interface ConnectorIndexResult {
  readonly sourceId: string;
  readonly items: number;
  readonly chunks: number;
  readonly error?: string;
}

export async function runConnectorIndex<E>(
  config: ConnectorIndexConfig<E>,
): Promise<ConnectorIndexResult> {
  const { step, orgId, sourceId, source, docType, provenance } = config;
  const indexMode: IndexMode = config.mode === 'full' ? 'full' : 'delta';

  // ── Fetch the full entity set (auth-revoked → mark errored, no retry) ──
  let entities: readonly E[];
  try {
    entities = (await step.run('fetch-entities', () => config.fetchEntities() as Promise<unknown>)) as readonly E[];
  } catch (err) {
    if (config.isAuthError(err)) {
      await markErrored(step, sourceId, config.reconnectMessage);
      return { sourceId, items: 0, chunks: 0, error: 'connector_auth' };
    }
    throw err;
  }

  await step.run('set-total', async () => {
    await createServiceRoleClient().from('sources').update({ total_files: entities.length }).eq('id', sourceId);
  });

  // ── Prepare phase: chunk every entity to fingerprint it (no paid embed
  // here). Drives the indexing progress bar across the full set. ──────────
  const prepared: PreparedDoc[] = [];
  let scanned = 0;
  for (let i = 0; i < entities.length; i += PREPARE_BATCH) {
    const batch = entities.slice(i, i + PREPARE_BATCH);
    let batchPrepared: PreparedDoc[];
    try {
      batchPrepared = (await step.run(`prepare-${String(i)}`, async () => {
        const results = await Promise.all(batch.map((e) => config.prepare(e)));
        return results.filter((p): p is PreparedDoc => p !== null);
      })) as PreparedDoc[];
    } catch (err) {
      if (config.isAuthError(err)) {
        await markErrored(step, sourceId, config.reconnectMessage);
        return { sourceId, items: prepared.length, chunks: totalChunks(prepared), error: 'connector_auth' };
      }
      throw err;
    }
    prepared.push(...batchPrepared);
    scanned += batch.length;
    const progress = scanned;
    await step.run(`prepare-counter-${String(i)}`, async () => {
      await createServiceRoleClient().from('sources').update({ indexed_files: progress }).eq('id', sourceId);
    });
  }

  // ── Reconcile against the corpus ────────────────────────────────────────
  const desired = new Map(
    prepared.map((p) => [p.docId, { hash: contentHashFromTexts(p.chunks.map((c) => c.text)) }]),
  );
  const recon = (await step.run('reconcile', async () => {
    return await reconcile(createServiceRoleClient(), {
      sourceId,
      ownedTypes: [docType],
      desired,
      mode: indexMode,
      // We only reach here if fetchEntities resolved without throwing, and
      // it contracts to throw on partial failure — so the set is complete.
      fetchComplete: true,
      confirmedEmpty: indexMode === 'full' && desired.size === 0,
    });
  })) as ReconcileResult;

  // ── Embed + write only new/changed, batched ─────────────────────────────
  const kindByDocId = new Map<string, ToIndexKind>(recon.toIndex.map((t) => [t.docId, t.kind]));
  const toWrite = prepared.filter((p) => kindByDocId.has(p.docId));
  const embedder = new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') });

  for (let i = 0; i < toWrite.length; i += EMBED_BATCH) {
    const batch = toWrite.slice(i, i + EMBED_BATCH);
    await step.run(`embed-${String(i)}`, async () => {
      const db = createServiceRoleClient();
      for (const doc of batch) {
        const kind = kindByDocId.get(doc.docId);
        if (kind === undefined) continue;

        let embeddings;
        try {
          embeddings = await embedder.embed({
            items: doc.chunks.map((c, idx) => ({ id: `${doc.docId}::${String(idx)}`, text: c.text, domain: c.domain })),
          });
        } catch (err) {
          if (err instanceof EmbeddingRateLimitError) throw err;
          // Changed docs haven't been cleared yet (writeReconciledDoc clears
          // just before re-inserting), so skipping leaves the old version
          // intact — but a changed doc that never re-embeds would read as
          // stale forever, so throw to force a retry. New docs: skip.
          if (kind === 'changed') {
            throw new Error(`${source} embed failed for changed ${doc.docId}: ${String(err)}`);
          }
          continue;
        }

        await writeReconciledDoc(db, {
          docId: doc.docId,
          kind,
          hash: contentHashFromTexts(doc.chunks.map((c) => c.text)),
          doc: {
            orgId,
            sourceId,
            source,
            type: docType,
            title: doc.title,
            url: doc.url,
            provenance,
            updatedAt: doc.updatedAt,
          },
          chunks: doc.chunks.map((c, idx) => ({
            chunkId: `${doc.docId}::${String(idx)}`,
            domain: c.domain,
            text: c.text,
            position: idx,
          })),
          embeddings: doc.chunks.map((_, idx) => arrayToVectorLiteral(embeddings.vectors[idx]!.vector)),
        });
      }
    });
  }

  // ── Finalize: counters reflect the WHOLE current source ─────────────────
  const items = prepared.length;
  const chunks = totalChunks(prepared);
  await step.run('finalize', async () => {
    await createServiceRoleClient()
      .from('sources')
      .update({
        status: 'idle',
        last_indexed_at: new Date().toISOString(),
        indexed_files: items,
        total_files: items,
        chunk_count: chunks,
      })
      .eq('id', sourceId);
  });

  console.info(
    `[index-${source}] source ${sourceId} (${indexMode}): ` +
      `new=${String(recon.counts.new)} changed=${String(recon.counts.changed)} ` +
      `unchanged=${String(recon.counts.unchanged)} removed=${String(recon.counts.removed)} ` +
      `items=${String(items)} chunks=${String(chunks)}`,
  );
  return { sourceId, items, chunks };
}

function totalChunks(prepared: readonly PreparedDoc[]): number {
  return prepared.reduce((sum, p) => sum + p.chunks.length, 0);
}

async function markErrored(step: StepLike, sourceId: string, message: string): Promise<void> {
  await step.run('mark-auth-errored', async () => {
    await createServiceRoleClient()
      .from('sources')
      .update({ status: 'errored', status_message: message })
      .eq('id', sourceId);
  });
}

function arrayToVectorLiteral(vec: Float32Array): string {
  return `[${Array.from(vec).join(',')}]`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
