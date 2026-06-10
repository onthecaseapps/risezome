import { VoyageEmbedder, EmbeddingRateLimitError, type EmbeddingDomain } from '@risezome/engine/embed';
import {
  contextualizeChunks,
  contextualizedText,
  type ContextGenerator,
} from '@risezome/engine/contextualize';
import { summarizeDoc, type DocSummarizer } from '@risezome/engine/summarize-doc';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import type { IndexMode } from '../client';
import { mapWithConcurrency } from './concurrency';
import { docConcurrency } from './contextualizer';
import {
  reconcile,
  writeReconciledDoc,
  contentHashFromTexts,
  type CorpusWriteClient,
  type ReconcileResult,
  type ToIndexKind,
} from './corpus-reconcile';
import { pgCorpusWriter } from './corpus-pg';
import {
  makeEntityFilter,
  type ConnectorKind,
  type EffectiveCorpusPolicy,
  type EntityAttrs,
} from './corpus-policy';

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

// Entities per prepare step. One step per batch (progress counter folded in)
// must keep big sources under Inngest's ~1000-step cap.
const PREPARE_BATCH = 40;
const EMBED_BATCH = 5;

export interface PreparedDoc {
  readonly docId: string;
  readonly title: string;
  readonly url: string | null;
  readonly updatedAt: string;
  /** Full source-doc text, used to generate per-chunk contextual-retrieval
   *  context (the cache-block source). Defaults to the joined chunk text. */
  readonly docText?: string;
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
  /** Optional contextual-retrieval generator (U3). When set, each chunk gets
   *  an LLM context prepended to its embedded + lexically-indexed text. When
   *  omitted, chunks index body-only (prior behavior). */
  readonly contextGenerator?: ContextGenerator | undefined;
  /** Optional per-document summarizer (U6). When set, each doc gets an
   *  is_summary chunk (embedded + searchable, excluded from content_hash). */
  readonly docSummarizer?: DocSummarizer | undefined;
  /** Corpus write client. Defaults to the direct-Postgres writer (bypasses
   *  the REST/Cloudflare WAF). Tests inject an in-memory fake. */
  readonly corpusWriter?: CorpusWriteClient | undefined;
  /** Resolved corpus policy for this source. When set together with
   *  `entityAttrs`, entities the policy excludes are dropped before prepare
   *  (and pruned by reconcile). Omitted ⇒ no entity filtering. */
  readonly corpusPolicy?: EffectiveCorpusPolicy | undefined;
  /** Maps one entity to the normalized attributes the policy matcher reads
   *  (status/list/updatedAt). Required for entity filtering. */
  readonly entityAttrs?: ((entity: E) => EntityAttrs) | undefined;
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
  let fetched: readonly E[];
  try {
    fetched = (await step.run('fetch-entities', () => config.fetchEntities() as Promise<unknown>)) as readonly E[];
  } catch (err) {
    if (config.isAuthError(err)) {
      await markErrored(step, orgId, sourceId, config.reconnectMessage);
      return { sourceId, items: 0, chunks: 0, error: 'connector_auth' };
    }
    throw err;
  }

  // Apply the corpus policy's connector rules. Excluded entities never enter
  // the desired set, so reconcile prunes any previously-indexed doc for them
  // (R5). `excludedByPolicy` drives the UI's "K excluded by policy".
  const entities = filterEntitiesByPolicy(fetched, source, config.corpusPolicy, config.entityAttrs);
  const excludedByPolicy = fetched.length - entities.length;

  await step.run('set-total', async () => {
    await createServiceRoleClient()
      .from('sources')
      .update({ total_files: entities.length, excluded_count: excludedByPolicy })
      .eq('id', sourceId)
      .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
  });

  // ── Prepare phase: chunk every entity to fingerprint it (no paid embed
  // here). Drives the indexing progress bar across the full set. ──────────
  const prepared: PreparedDoc[] = [];
  let scanned = 0;
  for (let i = 0; i < entities.length; i += PREPARE_BATCH) {
    const batch = entities.slice(i, i + PREPARE_BATCH);
    const progress = scanned + batch.length;
    let batchPrepared: PreparedDoc[];
    try {
      batchPrepared = (await step.run(`prepare-${String(i)}`, async () => {
        const results = await Promise.all(batch.map((e) => config.prepare(e)));
        // Progress counter folded into the batch step (one step per batch
        // keeps big sources under Inngest's ~1000-step cap).
        await createServiceRoleClient()
          .from('sources')
          .update({ indexed_files: progress })
          .eq('id', sourceId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        return results.filter((p): p is PreparedDoc => p !== null);
      })) as PreparedDoc[];
    } catch (err) {
      if (config.isAuthError(err)) {
        await markErrored(step, orgId, sourceId, config.reconnectMessage);
        return { sourceId, items: prepared.length, chunks: totalChunks(prepared), error: 'connector_auth' };
      }
      throw err;
    }
    prepared.push(...batchPrepared);
    scanned += batch.length;
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
  const writer = config.corpusWriter ?? pgCorpusWriter();

  for (let i = 0; i < toWrite.length; i += EMBED_BATCH) {
    const batch = toWrite.slice(i, i + EMBED_BATCH);
    await step.run(`embed-${String(i)}`, async () => {
      await mapWithConcurrency(batch, docConcurrency(), async (doc) => {
        const kind = kindByDocId.get(doc.docId);
        if (kind === undefined) return;

        // Contextual Retrieval (U3): generate a per-chunk context and prepend
        // it to the EMBEDDED text; the verbatim body stays in `text` for
        // display + citation matching, and the context is folded into
        // text_fts via the doc_chunks.context column.
        const bodies = doc.chunks.map((c) => c.text);
        const docFullText = doc.docText ?? bodies.join('\n\n');
        const contexts =
          config.contextGenerator !== undefined
            ? await contextualizeChunks(docFullText, bodies, config.contextGenerator)
            : bodies.map(() => '');

        // Per-document summary (U6): an extra is_summary chunk, embedded +
        // searchable, EXCLUDED from content_hash (its LLM text mustn't
        // destabilize change detection).
        const summary =
          config.docSummarizer !== undefined
            ? await summarizeDoc(docFullText, doc.title, config.docSummarizer)
            : '';

        // Embed body chunks (contextualized) + the summary in one request.
        const embedItems = doc.chunks.map((c, idx) => ({
          id: `${doc.docId}::${String(idx)}`,
          text: contextualizedText(contexts[idx] ?? '', c.text),
          domain: c.domain,
        }));
        if (summary.length > 0) {
          embedItems.push({ id: `${doc.docId}::summary`, text: summary, domain: 'text' });
        }

        let embeddings;
        try {
          embeddings = await embedder.embed({ items: embedItems });
        } catch (err) {
          if (err instanceof EmbeddingRateLimitError) throw err;
          // Changed docs haven't been cleared yet (writeReconciledDoc clears
          // just before re-inserting), so skipping leaves the old version
          // intact — but a changed doc that never re-embeds would read as
          // stale forever, so throw to force a retry. New docs: skip.
          if (kind === 'changed') {
            throw new Error(`${source} embed failed for changed ${doc.docId}: ${String(err)}`);
          }
          return;
        }

        const writeChunks: Array<{
          chunkId: string;
          domain: EmbeddingDomain;
          text: string;
          context: string;
          isSummary?: boolean;
          position: number;
        }> = doc.chunks.map((c, idx) => ({
          chunkId: `${doc.docId}::${String(idx)}`,
          domain: c.domain,
          text: c.text,
          context: contexts[idx] ?? '',
          position: idx,
        }));
        if (summary.length > 0) {
          writeChunks.push({
            chunkId: `${doc.docId}::summary`,
            domain: 'text',
            text: summary,
            context: '',
            isSummary: true,
            position: doc.chunks.length,
          });
        }

        await writeReconciledDoc(writer, {
          docId: doc.docId,
          kind,
          // Body-only hash: the summary chunk must not affect change detection.
          hash: contentHashFromTexts(bodies),
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
          chunks: writeChunks,
          embeddings: embedItems.map((_, idx) => arrayToVectorLiteral(embeddings.vectors[idx]!.vector)),
        });
      });
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
      .eq('id', sourceId)
      .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      // Removal is sticky: if the source was deselected while this run was in
      // flight, 'removed' must survive (the purge cron keys on it) — without
      // this guard the finalize write resurrected the source and its content
      // was never purged.
      .neq('status', 'removed');
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

const CONNECTOR_KINDS: ReadonlySet<string> = new Set(['jira', 'trello', 'confluence']);

/**
 * Drop entities the corpus policy excludes. No-op unless both a policy and an
 * attribute extractor are supplied and `source` is a known connector kind.
 * Exported for testing.
 */
export function filterEntitiesByPolicy<E>(
  fetched: readonly E[],
  source: string,
  policy: EffectiveCorpusPolicy | undefined,
  entityAttrs: ((entity: E) => EntityAttrs) | undefined,
): E[] {
  if (policy === undefined || entityAttrs === undefined || !CONNECTOR_KINDS.has(source)) {
    return [...fetched];
  }
  const keep = makeEntityFilter(policy, source as ConnectorKind);
  return fetched.filter((e) => keep(entityAttrs(e)));
}

async function markErrored(
  step: StepLike,
  orgId: string,
  sourceId: string,
  message: string,
): Promise<void> {
  await step.run('mark-auth-errored', async () => {
    await createServiceRoleClient()
      .from('sources')
      .update({ status: 'errored', status_message: message })
      .eq('id', sourceId)
      .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
      .neq('status', 'removed'); // removal is sticky — see finalize
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
