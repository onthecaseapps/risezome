import { createHash } from 'node:crypto';
import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import { inngest, type IndexMode } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { getInstallationOctokit } from '../../../app/_lib/github-app';
import { chunkIssue } from '../../lib/github/chunk-issues';
import type { GithubIssue } from '../../lib/github/issue-types';
import { reconcile, clearDocChunks } from '../lib/corpus-reconcile';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  contextualizeChunks,
  contextualizedText,
  type ContextGenerator,
} from '@risezome/engine/contextualize';
import { summarizeDoc, type DocSummarizer } from '@risezome/engine/summarize-doc';
import { optionalContextGenerator, optionalDocSummarizer, docConcurrency } from '../lib/contextualizer';

/** Doc types this indexer owns — reconcile must never touch the
 *  type='file' docs that share this source_id (corpus-reconcile R8). */
const OWNED_TYPES = ['issue', 'pull-request'];

/** SHA-256 of the joined chunk-input text — exact content fingerprint
 *  (changes only when embedded content changes, not on incidental
 *  activity like a label edit that doesn't alter chunk text). */
function contentHash(texts: readonly string[]): string {
  return createHash('sha256').update(texts.join('\n')).digest('hex');
}

/**
 * Index a single source's GitHub issues + pull requests into the Postgres
 * corpus, in parallel with the existing `indexRepoFn` which indexes the
 * repo tree. Both fire on the same `risezome/source.index-requested`
 * event so a manual reindex or webhook install triggers both at once.
 *
 *   1. Look up source + installation
 *   2. Fetch issues + PRs via `GET /repos/{owner}/{repo}/issues?state=all&sort=updated`
 *      using `since` derived from `max(docs.updated_at where type IN
 *      ('issue', 'pull-request'))` for idempotent re-runs
 *   3. For each issue/PR: chunkIssue → embed chunks → upsert docs +
 *      doc_chunks + corpus_chunk_embeddings
 *   4. Done; no source-status updates (the existing indexRepoFn owns
 *      the source.status lifecycle for the repo-tree path)
 *
 * The chunk-text format ("Issue owner/repo#42 — title. Status: open.
 * Labels: bug.") is the load-bearing contract for U6's corpus skills.
 * Do not change the wording without simultaneously updating U6's
 * snapshot tests.
 *
 * Concurrency: capped at 1 per sourceId so the cursor read + write
 * doesn't race a concurrent run.
 */
export const indexGithubIssuesFn = inngest.createFunction(
  {
    id: 'index-github-issues',
    name: 'Index a GitHub source — issues + PRs',
    concurrency: [
      { key: 'event.data.sourceId', limit: 1 },
      { key: 'event.data.orgId', limit: 2 },
    ],
    retries: 3,
    triggers: [{ event: 'risezome/source.index-requested' }],
  },
  async ({ event, step }) => {
    const { orgId, sourceId, mode } = (event as unknown as {
      data: { orgId: string; sourceId: string; mode?: IndexMode };
    }).data;
    const indexMode: IndexMode = mode === 'full' ? 'full' : 'delta';

    const source = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data, error } = await service
        .from('sources')
        .select('id, org_id, installation_id, repo_full_name, status')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || data === null) {
        throw new Error(`source not found: org=${orgId} source=${sourceId} (${error?.message ?? 'no row'})`);
      }
      // A queued index event can arrive after the repo was deselected
      // (status='removed', awaiting purge) — skip rather than re-index it.
      if ((data as { status: string }).status === 'removed') return null;
      return data as {
        id: string;
        org_id: string;
        installation_id: number;
        repo_full_name: string;
      };
    });
    if (source === null) {
      return { sourceId, issues: 0, chunks: 0, skipped: 'removed' };
    }

    const [owner, repo] = source.repo_full_name.split('/');
    if (owner === undefined || repo === undefined) {
      throw new Error(`malformed repo_full_name: ${source.repo_full_name}`);
    }
    const ownerRepo = `${owner}/${repo}`;

    // ── Step 1: cursor (delta only) ──────────────────────────────────
    // Delta uses max(updated_at over issue/PR docs) so only changed/new
    // issues are fetched. Full ignores the cursor and fetches the
    // complete set so removed issues become visible to the prune.
    const sinceParam =
      indexMode === 'full'
        ? null
        : await step.run('read-cursor', async () => {
            const service = createServiceRoleClient();
            const { data } = await service
              .from('docs')
              .select('updated_at')
              .eq('source_id', sourceId)
              .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
              .in('type', OWNED_TYPES)
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            return (data?.['updated_at'] as string | undefined) ?? null;
          });

    // ── Step 2: paginate, collecting the fetched issue set ───────────
    const PAGE_SIZE = 100;
    const allIssues: GithubIssue[] = [];
    let page = 1;
    while (true) {
      const issues = await step.run(`fetch-issues-page-${String(page)}`, async () => {
        const octokit = await getInstallationOctokit(source.installation_id);
        const resp = await octokit.request('GET /repos/{owner}/{repo}/issues', {
          owner,
          repo,
          state: 'all',
          sort: 'updated',
          direction: 'asc',
          per_page: PAGE_SIZE,
          page,
          ...(sinceParam !== null && { since: sinceParam }),
        });
        return resp.data as GithubIssue[];
      });
      allIssues.push(...issues);
      if (issues.length < PAGE_SIZE) break;
      page += 1;
    }

    // ── Step 3: build desired set (docId → content hash) ─────────────
    // chunkIssue is pure; chunk here to fingerprint, embed only the
    // new/changed subset below.
    const desired = new Map<string, { hash: string }>();
    for (const issue of allIssues) {
      const { doc, chunks } = chunkIssue(orgId, ownerRepo, issue);
      if (chunks.length === 0) continue;
      desired.set(doc.docId, { hash: contentHash(chunks.map((c) => c.text)) });
    }

    // ── Step 4: reconcile ────────────────────────────────────────────
    // Full reaches the complete set → prune removed issues (R3/R9).
    // Delta is incremental (cursor) → never prune (can't see removals).
    const recon = await step.run('reconcile', async () => {
      return await reconcile(createServiceRoleClient(), {
        sourceId,
        ownedTypes: OWNED_TYPES,
        desired,
        mode: indexMode,
        fetchComplete: indexMode === 'full',
        confirmedEmpty: indexMode === 'full' && desired.size === 0,
      });
    });

    // ── Step 5: embed only new/changed issues ────────────────────────
    const kindByDocId = new Map(recon.toIndex.map((t) => [t.docId, t.kind]));
    const toIndexIssues = allIssues.filter((i) => {
      const { doc } = chunkIssue(orgId, ownerRepo, i);
      return kindByDocId.has(doc.docId);
    });

    const embedder = new VoyageEmbedder({ apiKey: requireEnv('VOYAGE_API_KEY') });
    const contextGenerator = optionalContextGenerator();
    const docSummarizer = optionalDocSummarizer();
    const BATCH_SIZE = 20;
    let totalChunks = 0;
    for (let i = 0; i < toIndexIssues.length; i += BATCH_SIZE) {
      const batch = toIndexIssues.slice(i, i + BATCH_SIZE);
      const result = await step.run(`index-issues-batch-${String(i)}`, async () => {
        return await indexBatch({ batch, orgId, sourceId, ownerRepo, embedder, kindByDocId, contextGenerator, docSummarizer });
      });
      totalChunks += result.chunks;
    }

    console.info(
      `[index-github-issues] ${source.repo_full_name} (${indexMode}): ` +
        `new=${String(recon.counts.new)} changed=${String(recon.counts.changed)} ` +
        `unchanged=${String(recon.counts.unchanged)} removed=${String(recon.counts.removed)} ` +
        `chunks=${String(totalChunks)}`,
    );
    return { sourceId, chunks: totalChunks, ...recon.counts };
  },
);

/**
 * Embed + upsert a batch of new/changed issues, one issue at a time so a
 * single failure can't corrupt the others. Atomicity contract (R2/F5):
 *
 *   1. For a CHANGED issue, clearDocChunks first — its chunk count may have
 *      shrunk (a long body edited down leaves trailing chunkIds orphaned).
 *   2. Upsert the doc with content_hash = NULL (the FK needs the doc row
 *      before chunks; a null hash marks the doc as "not yet whole").
 *   3. Upsert chunks, then embeddings.
 *   4. Only after all of that commits, set content_hash = the fingerprint.
 *
 * If embedding fails mid-way for a CHANGED issue we've already cleared its
 * old chunks, so leaving content_hash null (or throwing) is the only safe
 * move — a future reindex sees hash=null ≠ desired hash, treats it as
 * changed, and rebuilds it. We throw so Inngest retries the batch. For a
 * NEW issue there's nothing to corrupt, so we skip it and continue.
 */
async function indexBatch(args: {
  batch: readonly GithubIssue[];
  orgId: string;
  sourceId: string;
  ownerRepo: string;
  embedder: VoyageEmbedder;
  kindByDocId: ReadonlyMap<string, 'new' | 'changed'>;
  contextGenerator: ContextGenerator | undefined;
  docSummarizer: DocSummarizer | undefined;
}): Promise<{ issues: number; chunks: number }> {
  const { batch, orgId, sourceId, ownerRepo, embedder, kindByDocId, contextGenerator, docSummarizer } = args;
  const service = createServiceRoleClient();

  const perDoc = await mapWithConcurrency(batch, docConcurrency(), async (issue) => {
    const { doc, chunks } = chunkIssue(orgId, ownerRepo, issue);
    if (chunks.length === 0) return { issues: 0, chunks: 0 };
    const kind = kindByDocId.get(doc.docId);
    if (kind === undefined) return { issues: 0, chunks: 0 }; // unchanged — reconcile didn't select it

    // Contextual Retrieval (U3): per-chunk context prepended to the embedded
    // text; verbatim body stays in `text`, context folded into text_fts.
    const bodies = chunks.map((c) => c.text);
    const docFullText = bodies.join('\n\n');
    const contexts =
      contextGenerator !== undefined
        ? await contextualizeChunks(docFullText, bodies, contextGenerator)
        : bodies.map(() => '');
    // Per-document summary chunk (U6), excluded from content_hash.
    const summary =
      docSummarizer !== undefined ? await summarizeDoc(docFullText, doc.title, docSummarizer) : '';

    const embedItems = chunks.map((c, i) => ({
      id: c.chunkId,
      text: contextualizedText(contexts[i] ?? '', c.text),
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
      // A changed issue hasn't been cleared yet (we clear below, after a
      // successful embed), so skipping here leaves the old version intact.
      if (kind === 'changed') {
        throw new Error(`embed failed for changed issue ${doc.docId}: ${String(err)}`);
      }
      return { issues: 0, chunks: 0 };
    }

    // Changed: drop stale chunks/embeddings before re-inserting. Cascade
    // deletes the matching corpus_chunk_embeddings rows.
    if (kind === 'changed') {
      await clearDocChunks(service, doc.docId, orgId);
    }

    const { error: docErr } = await service.from('docs').upsert({
      id: doc.docId,
      org_id: orgId,
      source_id: sourceId,
      source: 'github',
      type: doc.type,
      title: doc.title,
      body_summary: doc.bodySummary,
      entities: doc.entities,
      authors: doc.authors,
      url: doc.url,
      provenance: 'untrusted',
      updated_at: doc.updatedAt,
      content_hash: null, // marked whole only after chunks+embeddings commit
    });
    if (docErr !== null) {
      throw new Error(`docs upsert failed for ${doc.docId}: ${docErr.message}`);
    }

    const chunkRows: Array<{
      chunk_id: string;
      org_id: string;
      doc_id: string;
      domain: string;
      text: string;
      context: string;
      is_summary: boolean;
      position: number;
      source_id: string;
    }> = chunks.map((c, i) => ({
      chunk_id: c.chunkId,
      org_id: orgId,
      source_id: sourceId, // U4: denormalized for the retrieval source filter
      doc_id: c.docId,
      domain: c.domain,
      text: c.text,
      context: contexts[i] ?? '',
      is_summary: false,
      position: c.position,
    }));
    if (summary.length > 0) {
      chunkRows.push({
        chunk_id: `${doc.docId}::summary`,
        org_id: orgId,
        source_id: sourceId,
        doc_id: doc.docId,
        domain: 'text',
        text: summary,
        context: '',
        is_summary: true,
        position: chunks.length,
      });
    }
    const { error: chunkErr } = await service
      .from('doc_chunks')
      .upsert(chunkRows, { onConflict: 'chunk_id' });
    if (chunkErr !== null) {
      throw new Error(`doc_chunks upsert failed for ${doc.docId}: ${chunkErr.message}`);
    }

    const embedRows = embedItems.map((it, i) => ({
      chunk_id: it.id,
      org_id: orgId,
      source_id: sourceId, // U4: denormalized for the retrieval source filter
      domain: it.domain, // domain-partitioned dense search
      embedding: arrayToVectorLiteral(embeddings.vectors[i]!.vector),
    }));
    const { error: embErr } = await service
      .from('corpus_chunk_embeddings')
      .upsert(embedRows, { onConflict: 'chunk_id' });
    if (embErr !== null) {
      throw new Error(`embeddings upsert failed for ${doc.docId}: ${embErr.message}`);
    }

    // Now the doc is whole — stamp the fingerprint so the next reindex can
    // skip it as unchanged.
    const { error: hashErr } = await service
      .from('docs')
      .update({ content_hash: contentHash(chunks.map((c) => c.text)) })
      .eq('id', doc.docId)
      .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    if (hashErr !== null) {
      throw new Error(`content_hash update failed for ${doc.docId}: ${hashErr.message}`);
    }

    return { issues: 1, chunks: chunks.length };
  });

  return perDoc.reduce(
    (acc, r) => ({ issues: acc.issues + r.issues, chunks: acc.chunks + r.chunks }),
    { issues: 0, chunks: 0 },
  );
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
