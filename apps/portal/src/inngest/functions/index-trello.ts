import { chunkFile } from '@risezome/engine/chunker';
import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { requireTrelloApiKey, TrelloAuthError } from '../../../app/_lib/trello';
import {
  fetchBoardCards,
  fetchCardComments,
  type TrelloCard,
  type TrelloClientOptions,
} from '../../../app/_lib/trello-client';
import { buildCardDocText, trelloCardDocId } from '../../../app/_lib/trello-doc';

/**
 * Index a single Trello board source end-to-end. Mirrors index-repo.ts:
 *
 *   1. Mark source `indexing`, clear prior error
 *   2. Load the org's Trello token (service-role; the token is a secret)
 *   3. Fetch the board's non-archived cards (client excludes archived lists)
 *   4. For each card (in batches): fetch comments, build doc text (name + desc +
 *      comments), chunk as text, embed (Voyage voyage-3-large), upsert
 *      docs/doc_chunks/corpus_chunk_embeddings
 *   5. Mark source `idle`, last_indexed_at = now()
 *
 * Failure modes:
 *   - TrelloAuthError (401, revoked token) → mark `errored` with a re-connect
 *     message and RETURN (not transient; no Inngest retry).
 *   - EmbeddingRateLimitError → rethrow so Inngest retries with backoff.
 *
 * V1 does a full re-index each run (no incremental). Concurrency mirrors the
 * GitHub indexer: 1 per source, 2 per org.
 */
export const indexTrelloFn = inngest.createFunction(
  {
    id: 'index-trello',
    name: 'Index a Trello board source',
    concurrency: [
      { key: 'event.data.sourceId', limit: 1 },
      { key: 'event.data.orgId', limit: 2 },
    ],
    retries: 3,
    triggers: [{ event: 'risezome/trello.index-requested' }],
  },
  async ({ event, step }) => {
    const { orgId, sourceId } = (event as unknown as { data: { orgId: string; sourceId: string } }).data;

    // ── Step 1: load source + token, mark indexing ──────────────────
    const ctx = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data: source, error } = await service
        .from('sources')
        .select('id, org_id, kind, connection_id, external_id, display_name')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || source === null) {
        throw new Error(`trello source not found: org=${orgId} source=${sourceId} (${error?.message ?? 'no row'})`);
      }
      if (source.kind !== 'trello' || source.connection_id === null || source.external_id === null) {
        throw new Error(`source ${sourceId} is not an indexable Trello board`);
      }
      const { data: conn, error: connErr } = await service
        .from('trello_connections')
        .select('token')
        .eq('id', source.connection_id as string)
        .single();
      if (connErr !== null || conn === null) {
        throw new Error(`trello connection missing for source ${sourceId}`);
      }
      await service
        .from('sources')
        .update({ status: 'indexing', status_message: null, indexed_files: 0, total_files: null, chunk_count: 0 })
        .eq('id', sourceId);
      return { boardId: source.external_id as string, token: conn.token as string };
    });

    const trello: TrelloClientOptions = { token: ctx.token, apiKey: requireTrelloApiKey() };

    // ── Step 2: fetch the board's non-archived cards ────────────────
    let cards: TrelloCard[];
    try {
      cards = await step.run('fetch-cards', async () => fetchBoardCards(ctx.boardId, trello));
    } catch (err) {
      if (err instanceof TrelloAuthError) {
        await step.run('mark-auth-errored', async () => {
          await createServiceRoleClient()
            .from('sources')
            .update({ status: 'errored', status_message: 'Trello access was revoked. Reconnect Trello to re-index.' })
            .eq('id', sourceId);
        });
        return { sourceId, cards: 0, chunks: 0, error: 'trello_auth' };
      }
      throw err;
    }

    await step.run('set-total', async () => {
      await createServiceRoleClient().from('sources').update({ total_files: cards.length }).eq('id', sourceId);
    });
    if (cards.length === 0) {
      await step.run('finalize-empty', async () => {
        await createServiceRoleClient()
          .from('sources')
          .update({ status: 'idle', last_indexed_at: new Date().toISOString() })
          .eq('id', sourceId);
      });
      return { sourceId, cards: 0, chunks: 0 };
    }

    // ── Step 3: batched fetch-comments + embed + write ──────────────
    const BATCH_SIZE = 5;
    const embedder = new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') });

    let indexedCards = 0;
    let chunkCount = 0;
    for (let i = 0; i < cards.length; i += BATCH_SIZE) {
      const batch = cards.slice(i, i + BATCH_SIZE);
      let result: { cards: number; chunks: number };
      try {
        result = await step.run(`index-batch-${i}`, async () =>
          indexCardBatch({ batch, boardId: ctx.boardId, orgId, sourceId, trello, embedder }),
        );
      } catch (err) {
        if (err instanceof TrelloAuthError) {
          await step.run(`mark-auth-errored-${i}`, async () => {
            await createServiceRoleClient()
              .from('sources')
              .update({ status: 'errored', status_message: 'Trello access was revoked. Reconnect Trello to re-index.' })
              .eq('id', sourceId);
          });
          return { sourceId, cards: indexedCards, chunks: chunkCount, error: 'trello_auth' };
        }
        throw err; // EmbeddingRateLimitError + others → Inngest retry
      }
      indexedCards += result.cards;
      chunkCount += result.chunks;
      await step.run(`update-counter-${i}`, async () => {
        await createServiceRoleClient()
          .from('sources')
          .update({ indexed_files: indexedCards, chunk_count: chunkCount })
          .eq('id', sourceId);
      });
    }

    await step.run('finalize', async () => {
      await createServiceRoleClient()
        .from('sources')
        .update({ status: 'idle', last_indexed_at: new Date().toISOString() })
        .eq('id', sourceId);
    });

    return { sourceId, cards: indexedCards, chunks: chunkCount };
  },
);

async function indexCardBatch(args: {
  batch: TrelloCard[];
  boardId: string;
  orgId: string;
  sourceId: string;
  trello: TrelloClientOptions;
  embedder: VoyageEmbedder;
}): Promise<{ cards: number; chunks: number }> {
  const { batch, boardId, orgId, sourceId, trello, embedder } = args;
  const service = createServiceRoleClient();
  let cards = 0;
  let chunks = 0;

  for (const card of batch) {
    const comments = await fetchCardComments(card.id, trello);
    const text = buildCardDocText(card, comments);
    // Synthetic `.md` path routes the chunker to the text domain (voyage-3-large).
    const chunkInputs = chunkFile('trello-card.md', text);
    if (chunkInputs.length === 0) continue;

    let embeddings;
    try {
      embeddings = await embedder.embed({
        items: chunkInputs.map((c, i) => ({ id: `${card.id}::${i}`, text: c.text, domain: c.domain })),
      });
    } catch (err) {
      if (err instanceof EmbeddingRateLimitError) throw err;
      continue;
    }

    const docId = trelloCardDocId(boardId, card.id);
    const { error: docErr } = await service.from('docs').upsert({
      id: docId,
      org_id: orgId,
      source_id: sourceId,
      source: 'trello',
      type: 'card',
      title: card.name,
      url: card.url,
      provenance: 'trusted',
      updated_at: new Date().toISOString(),
    });
    if (docErr !== null) continue;

    const chunkRows = chunkInputs.map((c, i) => ({
      chunk_id: `${docId}::${i}`,
      org_id: orgId,
      doc_id: docId,
      domain: c.domain,
      text: c.text,
      position: i,
    }));
    if ((await service.from('doc_chunks').upsert(chunkRows, { onConflict: 'chunk_id' })).error !== null) continue;

    const embedRows = chunkInputs.map((_, i) => ({
      chunk_id: `${docId}::${i}`,
      org_id: orgId,
      embedding: arrayToVectorLiteral(embeddings.vectors[i]!.vector),
    }));
    if ((await service.from('corpus_chunk_embeddings').upsert(embedRows, { onConflict: 'chunk_id' })).error !== null) continue;

    cards += 1;
    chunks += chunkInputs.length;
  }
  return { cards, chunks };
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
