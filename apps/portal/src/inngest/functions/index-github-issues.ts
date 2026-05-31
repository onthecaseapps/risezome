import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { getInstallationOctokit } from '../../../app/_lib/github-app';
import { chunkIssue } from '../../lib/github/chunk-issues';
import type { GithubIssue } from '../../lib/github/issue-types';

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
    const { orgId, sourceId } = (event as unknown as { data: { orgId: string; sourceId: string } }).data;

    const source = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data, error } = await service
        .from('sources')
        .select('id, org_id, installation_id, repo_full_name')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || data === null) {
        throw new Error(`source not found: org=${orgId} source=${sourceId} (${error?.message ?? 'no row'})`);
      }
      return data as {
        id: string;
        org_id: string;
        installation_id: number;
        repo_full_name: string;
      };
    });

    const [owner, repo] = source.repo_full_name.split('/');
    if (owner === undefined || repo === undefined) {
      throw new Error(`malformed repo_full_name: ${source.repo_full_name}`);
    }
    const ownerRepo = `${owner}/${repo}`;

    // ── Step 1: read cursor from current corpus state ────────────────
    // max(updated_at) where source_id = X AND type IN ('issue',
    // 'pull-request') is the natural cursor — fully idempotent: the
    // next run re-fetches the most recent doc but the upsert is a
    // no-op since the doc didn't change.
    const sinceParam = await step.run('read-cursor', async () => {
      const service = createServiceRoleClient();
      const { data } = await service
        .from('docs')
        .select('updated_at')
        .eq('source_id', sourceId)
        .in('type', ['issue', 'pull-request'])
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data?.['updated_at'] as string | undefined) ?? null;
    });

    // ── Step 2: paginate through issues + PRs ────────────────────────
    const PAGE_SIZE = 100;
    let page = 1;
    let totalIssues = 0;
    let totalChunks = 0;

    const embedder = new VoyageEmbedder({
      apiKey: requireEnv('VOYAGE_API_KEY'),
    });

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

      if (issues.length === 0) break;

      // ── Step 3: chunk + embed + upsert this batch ──────────────────
      const result = await step.run(`index-issues-page-${String(page)}`, async () => {
        return await indexBatch({ batch: issues, orgId, sourceId, ownerRepo, embedder });
      });
      totalIssues += result.issues;
      totalChunks += result.chunks;

      if (issues.length < PAGE_SIZE) break;
      page += 1;
    }

    // eslint-disable-next-line no-console
    console.info(`[index-github-issues] indexed ${source.repo_full_name}: ${String(totalIssues)} issues+PRs, ${String(totalChunks)} chunks`);
    return { sourceId, issues: totalIssues, chunks: totalChunks };
  },
);

async function indexBatch(args: {
  batch: readonly GithubIssue[];
  orgId: string;
  sourceId: string;
  ownerRepo: string;
  embedder: VoyageEmbedder;
}): Promise<{ issues: number; chunks: number }> {
  const { batch, orgId, sourceId, ownerRepo, embedder } = args;
  const service = createServiceRoleClient();

  let indexedIssues = 0;
  let chunkCount = 0;

  for (const issue of batch) {
    const { doc, chunks } = chunkIssue(ownerRepo, issue);
    if (chunks.length === 0) continue;

    let embeddings;
    try {
      embeddings = await embedder.embed({
        items: chunks.map((c) => ({
          id: c.chunkId,
          text: c.text,
          domain: c.domain,
        })),
      });
    } catch (err) {
      if (err instanceof EmbeddingRateLimitError) throw err;
      continue;
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
    });
    if (docErr !== null) continue;

    const chunkRows = chunks.map((c) => ({
      chunk_id: c.chunkId,
      org_id: orgId,
      doc_id: c.docId,
      domain: c.domain,
      text: c.text,
      position: c.position,
    }));
    const { error: chunkErr } = await service
      .from('doc_chunks')
      .upsert(chunkRows, { onConflict: 'chunk_id' });
    if (chunkErr !== null) continue;

    const embedRows = chunks.map((c, i) => ({
      chunk_id: c.chunkId,
      org_id: orgId,
      embedding: arrayToVectorLiteral(embeddings.vectors[i]!.vector),
    }));
    const { error: embErr } = await service
      .from('corpus_chunk_embeddings')
      .upsert(embedRows, { onConflict: 'chunk_id' });
    if (embErr !== null) continue;

    indexedIssues += 1;
    chunkCount += chunks.length;
  }

  return { issues: indexedIssues, chunks: chunkCount };
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
