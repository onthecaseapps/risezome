import { chunkFile } from '@risezome/engine/chunker';
import { inngest, type IndexMode } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { sanitizeStatusMessage } from '../lib/status-message';
import { decryptForOrgFromBytea } from '@risezome/crypto';
import { requireTrelloApiKey, TrelloAuthError } from '../../../app/_lib/trello';
import {
  fetchBoardCards,
  fetchCardComments,
  type TrelloCard,
  type TrelloClientOptions,
} from '../../../app/_lib/trello-client';
import { buildCardDocText, trelloCardDocId } from '../../../app/_lib/trello-doc';
import { runConnectorIndex, type PreparedDoc } from '../lib/connector-index';
import { optionalContextGenerator, optionalDocSummarizer } from '../lib/contextualizer';

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
    // Safety net: when all retries are exhausted, flip the source to
    // `errored` instead of leaving it wedged at `indexing` (which grays
    // out the Reindex button forever). Mirrors index-repo's onFailure.
    onFailure: async ({ event, error }) => {
      const original = (event as unknown as {
        data: { event: { data: { sourceId: string; orgId?: string } } };
      }).data.event;
      const sourceId = original?.data?.sourceId;
      const orgId = original?.data?.orgId;
      if (typeof sourceId !== 'string' || sourceId.length === 0) return;
      const message = error instanceof Error ? error.message : String(error);
      if (typeof orgId === 'string' && orgId.length > 0) {
        await createServiceRoleClient()
          .from('sources')
          .update({ status: 'errored', status_message: sanitizeStatusMessage(message) })
          .eq('id', sourceId)
          .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
          .neq('status', 'removed'); // removal is sticky (deselect↔index race)
      } else {
        // service-role-cross-org: onFailure for an event that carried no orgId
        // (older queued events) — the sources PK (id) is globally unique, so this
        // targets exactly one row; no org_id is available to scope by.
        await createServiceRoleClient()
          .from('sources')
          .update({ status: 'errored', status_message: sanitizeStatusMessage(message) })
          .eq('id', sourceId)
          .neq('status', 'removed'); // removal is sticky (deselect↔index race)
      }
    },
  },
  async ({ event, step }) => {
    const { orgId, sourceId, mode } = (
      event as unknown as {
        data: { orgId: string; sourceId: string; mode?: IndexMode };
      }
    ).data;

    const ctx = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data: source, error } = await service
        .from('sources')
        .select('id, org_id, kind, connection_id, external_id, display_name, status')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || source === null) {
        throw new Error(
          `trello source not found: org=${orgId} source=${sourceId} (${error?.message ?? 'no row'})`,
        );
      }
      // A queued index event can arrive after the source was deselected
      // (refcount hit zero → status='removed'). Indexing it would write fresh
      // content for a source awaiting purge — skip the run entirely.
      if (source.status === 'removed') return { removed: true as const };
      if (
        source.kind !== 'trello' ||
        source.connection_id === null ||
        source.external_id === null
      ) {
        throw new Error(`source ${sourceId} is not an indexable Trello board`);
      }
      await service
        .from('sources')
        .update({ status: 'indexing', status_message: null, indexed_files: 0, total_files: null })
        .eq('id', sourceId)
        .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        .neq('status', 'removed'); // removal is sticky (deselect↔index race)
      // U4: do NOT return the token from this memoized step — Inngest persists
      // step return values as run state, which would put the secret at rest
      // outside our DB/redaction boundary. Return only the connection id; the
      // token is resolved + decrypted fresh below (un-memoized).
      return {
        boardId: source.external_id as string,
        connectionId: source.connection_id as string,
      };
    });
    if ('removed' in ctx) {
      return { sourceId, cards: 0, chunks: 0, skipped: 'removed' };
    }

    // Resolve the decrypted Trello token outside any memoized step so it never
    // lands in Inngest run state (U3 decrypt + U4 no-persist).
    const trelloToken = await (async (): Promise<string> => {
      const service = createServiceRoleClient();
      const { data: conn, error: connErr } = await service
        .from('trello_connections')
        .select('token_enc')
        .eq('id', ctx.connectionId)
        .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        .single();
      if (connErr !== null || conn === null || conn.token_enc === null) {
        throw new Error(`trello connection missing for source ${sourceId}`);
      }
      // U10: token decrypted app-side under the org's per-org KMS key.
      return decryptForOrgFromBytea(orgId, conn.token_enc);
    })();

    const trello: TrelloClientOptions = { token: trelloToken, apiKey: requireTrelloApiKey() };

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
      docSummarizer: optionalDocSummarizer(),
      isAuthError: (err) => err instanceof TrelloAuthError,
      fetchEntities: () => fetchBoardCards(ctx.boardId, trello),
      prepare: async (card): Promise<PreparedDoc | null> => {
        const comments = await fetchCardComments(card.id, trello);
        const text = buildCardDocText(card, comments);
        // Synthetic `.md` path routes the chunker to the text domain (voyage-3-large).
        const chunks = chunkFile('trello-card.md', text);
        if (chunks.length === 0) return null;
        return {
          docId: trelloCardDocId(orgId, ctx.boardId, card.id),
          title: card.name,
          url: card.url,
          updatedAt: card.dateLastActivity ?? new Date().toISOString(),
          docText: text,
          chunks: chunks.map((c) => ({ text: c.text, domain: c.domain })),
        };
      },
    });

    return {
      sourceId,
      cards: result.items,
      chunks: result.chunks,
      ...(result.error !== undefined && { error: result.error }),
    };
  },
);
