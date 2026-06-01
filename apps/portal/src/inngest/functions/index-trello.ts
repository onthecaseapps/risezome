import { chunkFile } from '@risezome/engine/chunker';
import { inngest, type IndexMode } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { requireTrelloApiKey, TrelloAuthError } from '../../../app/_lib/trello';
import {
  fetchBoardCards,
  fetchCardComments,
  type TrelloCard,
  type TrelloClientOptions,
} from '../../../app/_lib/trello-client';
import { buildCardDocText, trelloCardDocId } from '../../../app/_lib/trello-doc';
import { runConnectorIndex, type PreparedDoc } from '../lib/connector-index';
import { optionalContextGenerator } from '../lib/contextualizer';

const RECONNECT_MSG = 'Trello access was revoked. Reconnect Trello to re-index.';

/**
 * Index a single Trello board source. Delegates the reconcile lifecycle
 * (skip-unchanged, atomic re-embed of changed cards, full-mode prune of
 * removed cards, counters, finalize) to the shared connector orchestrator;
 * this file supplies only the Trello specifics: load the board + token,
 * fetch its cards, and turn one card (name + desc + comments) into a
 * prepared doc.
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
    const { orgId, sourceId, mode } = (event as unknown as {
      data: { orgId: string; sourceId: string; mode?: IndexMode };
    }).data;

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
        .update({ status: 'indexing', status_message: null, indexed_files: 0, total_files: null })
        .eq('id', sourceId);
      return { boardId: source.external_id as string, token: conn.token as string };
    });

    const trello: TrelloClientOptions = { token: ctx.token, apiKey: requireTrelloApiKey() };

    const result = await runConnectorIndex<TrelloCard>({
      step,
      orgId,
      sourceId,
      mode,
      source: 'trello',
      docType: 'card',
      provenance: 'trusted',
      reconnectMessage: RECONNECT_MSG,
      contextGenerator: optionalContextGenerator(),
      isAuthError: (err) => err instanceof TrelloAuthError,
      fetchEntities: () => fetchBoardCards(ctx.boardId, trello),
      prepare: async (card): Promise<PreparedDoc | null> => {
        const comments = await fetchCardComments(card.id, trello);
        const text = buildCardDocText(card, comments);
        // Synthetic `.md` path routes the chunker to the text domain (voyage-3-large).
        const chunks = chunkFile('trello-card.md', text);
        if (chunks.length === 0) return null;
        return {
          docId: trelloCardDocId(ctx.boardId, card.id),
          title: card.name,
          url: card.url,
          updatedAt: card.dateLastActivity ?? new Date().toISOString(),
          docText: text,
          chunks: chunks.map((c) => ({ text: c.text, domain: c.domain })),
        };
      },
    });

    return { sourceId, cards: result.items, chunks: result.chunks, ...(result.error !== undefined && { error: result.error }) };
  },
);
