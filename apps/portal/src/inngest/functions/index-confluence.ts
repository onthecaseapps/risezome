import { chunkFile } from '@risezome/engine/chunker';
import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { AtlassianAuthError } from '../../../app/_lib/atlassian';
import { getValidAtlassianToken } from '../../../app/_lib/atlassian-token';
import { listConfluencePages, type AtlassianContext, type ConfluencePage } from '../../../app/_lib/atlassian-client';
import { buildPageDocText, confluencePageDocId } from '../../../app/_lib/atlassian-doc';

const RECONNECT_MSG = 'Atlassian access was revoked or expired. Reconnect Atlassian to re-index.';

/**
 * Index a single Confluence space's pages into the corpus. Mirrors index-jira /
 * index-trello: load source + token, list current pages with storage body, build
 * doc text (title + body), chunk/embed, upsert docs(source=confluence,type=page).
 */
export const indexConfluenceFn = inngest.createFunction(
  {
    id: 'index-confluence',
    name: 'Index a Confluence space source',
    concurrency: [
      { key: 'event.data.sourceId', limit: 1 },
      { key: 'event.data.orgId', limit: 2 },
    ],
    retries: 3,
    triggers: [{ event: 'risezome/confluence.index-requested' }],
  },
  async ({ event, step }) => {
    const { orgId, sourceId } = (event as unknown as { data: { orgId: string; sourceId: string } }).data;

    const ctx = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data: source, error } = await service
        .from('sources')
        .select('id, kind, external_id')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || source === null || source.kind !== 'confluence' || source.external_id === null) {
        throw new Error(`source ${sourceId} is not an indexable Confluence space`);
      }
      await service
        .from('sources')
        .update({ status: 'indexing', status_message: null, indexed_files: 0, total_files: null, chunk_count: 0 })
        .eq('id', sourceId);
      return { spaceId: source.external_id as string };
    });

    let token;
    let pages: ConfluencePage[];
    try {
      token = await step.run('token', async () => getValidAtlassianToken(orgId, createServiceRoleClient()));
      const client: AtlassianContext = { accessToken: token.accessToken, cloudId: token.cloudId };
      pages = await step.run('fetch-pages', async () => listConfluencePages(ctx.spaceId, client));
    } catch (err) {
      if (err instanceof AtlassianAuthError) {
        await markErrored(sourceId);
        return { sourceId, pages: 0, error: 'atlassian_auth' };
      }
      throw err;
    }

    await step.run('set-total', async () => {
      await createServiceRoleClient().from('sources').update({ total_files: pages.length }).eq('id', sourceId);
    });
    if (pages.length === 0) {
      await finalizeIdle(step, sourceId);
      return { sourceId, pages: 0, chunks: 0 };
    }

    const BATCH = 8;
    const embedder = new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') });
    const siteUrl = token.siteUrl ?? '';

    let indexed = 0;
    let chunkCount = 0;
    for (let i = 0; i < pages.length; i += BATCH) {
      const batch = pages.slice(i, i + BATCH);
      const result = await step.run(`index-batch-${i}`, async () =>
        indexPageBatch({ batch, cloudId: token.cloudId, siteUrl, orgId, sourceId, embedder }),
      );
      indexed += result.pages;
      chunkCount += result.chunks;
      await step.run(`counter-${i}`, async () => {
        await createServiceRoleClient()
          .from('sources')
          .update({ indexed_files: indexed, chunk_count: chunkCount })
          .eq('id', sourceId);
      });
    }

    await finalizeIdle(step, sourceId);
    return { sourceId, pages: indexed, chunks: chunkCount };
  },
);

async function indexPageBatch(args: {
  batch: ConfluencePage[];
  cloudId: string;
  siteUrl: string;
  orgId: string;
  sourceId: string;
  embedder: VoyageEmbedder;
}): Promise<{ pages: number; chunks: number }> {
  const { batch, cloudId, siteUrl, orgId, sourceId, embedder } = args;
  const service = createServiceRoleClient();
  let pages = 0;
  let chunks = 0;

  for (const page of batch) {
    const text = buildPageDocText(page);
    const chunkInputs = chunkFile('confluence-page.md', text);
    if (chunkInputs.length === 0) continue;

    let embeddings;
    try {
      embeddings = await embedder.embed({
        items: chunkInputs.map((c, i) => ({ id: `${page.id}::${i}`, text: c.text, domain: c.domain })),
      });
    } catch (err) {
      if (err instanceof EmbeddingRateLimitError) throw err;
      continue;
    }

    const docId = confluencePageDocId(cloudId, page.id);
    const { error: docErr } = await service.from('docs').upsert({
      id: docId,
      org_id: orgId,
      source_id: sourceId,
      source: 'confluence',
      type: 'page',
      title: page.title,
      url: siteUrl.length > 0 ? `${siteUrl}/wiki/pages/viewpage.action?pageId=${page.id}` : null,
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

    pages += 1;
    chunks += chunkInputs.length;
  }
  return { pages, chunks };
}

async function markErrored(sourceId: string): Promise<void> {
  await createServiceRoleClient()
    .from('sources')
    .update({ status: 'errored', status_message: RECONNECT_MSG })
    .eq('id', sourceId);
}

async function finalizeIdle(
  step: { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> },
  sourceId: string,
): Promise<void> {
  await step.run('finalize', async () => {
    await createServiceRoleClient()
      .from('sources')
      .update({ status: 'idle', last_indexed_at: new Date().toISOString() })
      .eq('id', sourceId);
  });
}

function arrayToVectorLiteral(vec: Float32Array): string {
  return `[${Array.from(vec).join(',')}]`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
