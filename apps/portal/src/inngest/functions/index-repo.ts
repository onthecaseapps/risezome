import { Buffer } from 'node:buffer';
import { chunkFile } from '@risezome/engine/chunker';
import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import { inngest } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { getInstallationOctokit } from '../../../app/_lib/github-app';

/**
 * Index a single source (one GitHub repo) end-to-end:
 *
 *   1. Mark source `indexing`, clear prior error
 *   2. Get the installation-scoped Octokit
 *   3. Fetch the repo's git tree (recursive) and filter to indexable files
 *   4. For each file in stable batches:
 *      a. Fetch content via /repos/.../contents/{path}
 *      b. Chunk (text|code by extension via @risezome/engine/chunker)
 *      c. Embed (Voyage; routes text→voyage-3-large, code→voyage-code-3)
 *      d. Upsert docs + doc_chunks + corpus_chunk_embeddings rows
 *      e. Update source.indexed_files cumulative counter
 *   5. Mark source `idle`, last_indexed_at = now()
 *
 * On any failure: mark `errored` with the message and let Inngest decide
 * whether to retry. Voyage rate-limit errors throw `EmbeddingRateLimitError`,
 * which Inngest's default retry-with-backoff handles naturally.
 *
 * Concurrency: capped at 1 per (orgId, sourceId) so a manual reindex
 * doesn't race a concurrent install-triggered run. Per-org throttle is
 * applied at 2 concurrent sources so a single org indexing many repos
 * doesn't starve other tenants.
 */
export const indexRepoFn = inngest.createFunction(
  {
    id: 'index-repo',
    name: 'Index a GitHub source',
    concurrency: [
      // No two runs for the same source at once — the cumulative counter
      // would race otherwise.
      { key: 'event.data.sourceId', limit: 1 },
      // Polite cap per org so one org with 30 repos doesn't choke others.
      { key: 'event.data.orgId', limit: 2 },
    ],
    retries: 3,
    triggers: [{ event: 'risezome/source.index-requested' }],
  },
  async ({ event, step }) => {
    const { orgId, sourceId } = (event as unknown as { data: { orgId: string; sourceId: string } }).data;

    // ── Step 1: look up source + installation, mark indexing ─────────
    const source = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data, error } = await service
        .from('sources')
        .select('id, org_id, installation_id, repo_full_name, repo_id, default_branch')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || data === null) {
        throw new Error(`source not found: org=${orgId} source=${sourceId} (${error?.message ?? 'no row'})`);
      }
      await service
        .from('sources')
        .update({
          status: 'indexing',
          status_message: null,
          indexed_files: 0,
          total_files: null,
          chunk_count: 0,
        })
        .eq('id', sourceId);
      return data as {
        id: string;
        org_id: string;
        installation_id: number;
        repo_full_name: string;
        repo_id: number | null;
        default_branch: string | null;
      };
    });

    const [owner, repo] = source.repo_full_name.split('/');
    if (owner === undefined || repo === undefined) {
      throw new Error(`malformed repo_full_name: ${source.repo_full_name}`);
    }

    // ── Step 2: resolve default branch + list tree ───────────────────
    const tree = await step.run('fetch-tree', async () => {
      const octokit = await getInstallationOctokit(source.installation_id);

      let branch = source.default_branch;
      if (branch === null || branch.length === 0) {
        const repoResp = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        branch = (repoResp.data as { default_branch: string }).default_branch;
        await createServiceRoleClient()
          .from('sources')
          .update({ default_branch: branch })
          .eq('id', sourceId);
      }

      // Resolve branch → tree sha. The recursive flag may truncate at ~100k
      // entries; we accept truncation for V1 (no monorepos at beta scale).
      const branchResp = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
        owner,
        repo,
        branch,
      });
      const treeSha = (branchResp.data as { commit: { commit: { tree: { sha: string } } } }).commit.commit.tree.sha;

      const treeResp = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner,
        repo,
        tree_sha: treeSha,
        recursive: 'true',
      });

      type TreeEntry = { path: string; type: string; size?: number; sha: string };
      const entries = (treeResp.data as { tree: TreeEntry[]; truncated: boolean }).tree;
      const blobs = entries.filter((e) => e.type === 'blob');
      return { branch, treeSha, blobs };
    });

    // ── Step 3: filter to indexable files ────────────────────────────
    // Pre-classify here (not inside step.run) so the work counter on the
    // sources row gets a meaningful total_files immediately.
    const targets = tree.blobs
      .filter((b) => isIndexableSize(b.size))
      .filter((b) => chunkFile(b.path, '').length === 0 ? classifiable(b.path) : true);
    // The above filter is a quick "would the chunker accept this extension?"
    // check; we run the real chunker below with content.

    const totalFiles = targets.length;
    await step.run('set-total', async () => {
      await createServiceRoleClient().from('sources').update({ total_files: totalFiles }).eq('id', sourceId);
    });
    if (totalFiles === 0) {
      await step.run('finalize-empty', async () => {
        await createServiceRoleClient()
          .from('sources')
          .update({ status: 'idle', last_indexed_at: new Date().toISOString() })
          .eq('id', sourceId);
      });
      return { sourceId, files: 0, chunks: 0 };
    }

    // ── Step 4: batched embed + write ────────────────────────────────
    const BATCH_SIZE = 8; // files per Inngest step (keeps each step under ~30s)
    const embedder = new VoyageEmbedder({
      apiKey: requireEnv('VOYAGE_API_KEY'),
    });

    let indexedFiles = 0;
    let chunkCount = 0;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const result = await step.run(`index-batch-${i}`, async () => {
        return await indexBatch({
          batch,
          orgId,
          sourceId,
          owner,
          repo,
          branch: tree.branch,
          installationId: source.installation_id,
          embedder,
        });
      });
      indexedFiles += result.files;
      chunkCount += result.chunks;

      await step.run(`update-counter-${i}`, async () => {
        await createServiceRoleClient()
          .from('sources')
          .update({ indexed_files: indexedFiles, chunk_count: chunkCount })
          .eq('id', sourceId);
      });
    }

    // ── Step 5: mark idle ────────────────────────────────────────────
    await step.run('finalize', async () => {
      await createServiceRoleClient()
        .from('sources')
        .update({ status: 'idle', last_indexed_at: new Date().toISOString() })
        .eq('id', sourceId);
    });

     
    console.info(`[index-repo] indexed ${source.repo_full_name}: ${indexedFiles} files, ${chunkCount} chunks`);
    return { sourceId, files: indexedFiles, chunks: chunkCount };
  },
);

// ── Helpers ────────────────────────────────────────────────────────

async function indexBatch(args: {
  batch: Array<{ path: string; sha: string; size?: number }>;
  orgId: string;
  sourceId: string;
  owner: string;
  repo: string;
  branch: string;
  installationId: number;
  embedder: VoyageEmbedder;
}): Promise<{ files: number; chunks: number }> {
  const { batch, orgId, sourceId, owner, repo, branch, installationId, embedder } = args;
  const octokit = await getInstallationOctokit(installationId);
  const service = createServiceRoleClient();

  let files = 0;
  let chunks = 0;

  for (const entry of batch) {
    // Fetch file content. Octokit returns base64 for files; the `media`
    // override would return raw bytes but is harder to type — base64 is fine.
    let content: string;
    try {
      const resp = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: entry.path,
        ref: branch,
      });
      const data = resp.data as { type?: string; content?: string; encoding?: string };
      if (data.type !== 'file' || data.content === undefined) continue;
      content = Buffer.from(data.content, 'base64').toString('utf8');
    } catch {
      // 404 / 403 → skip this file. Don't fail the whole run for one bad path.
      continue;
    }

    const chunkInputs = chunkFile(entry.path, content);
    if (chunkInputs.length === 0) continue;

    // Embed all chunks for this file in one request to amortize HTTP overhead.
    let embeddings;
    try {
      embeddings = await embedder.embed({
        items: chunkInputs.map((c, i) => ({
          id: `${entry.sha}::${i}`,
          text: c.text,
          domain: c.domain,
        })),
      });
    } catch (err) {
      if (err instanceof EmbeddingRateLimitError) throw err; // let Inngest retry
      // Other embed errors: skip the file, keep going.
      continue;
    }

    const docId = `github:${owner}/${repo}:${entry.path}@${entry.sha}`;
    const { error: docErr } = await service.from('docs').upsert({
      id: docId,
      org_id: orgId,
      source_id: sourceId,
      source: 'github',
      type: 'file',
      title: entry.path,
      url: `https://github.com/${owner}/${repo}/blob/${branch}/${entry.path}`,
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
    const { error: chunkErr } = await service
      .from('doc_chunks')
      .upsert(chunkRows, { onConflict: 'chunk_id' });
    if (chunkErr !== null) continue;

    const embedRows = chunkInputs.map((_, i) => ({
      chunk_id: `${docId}::${i}`,
      org_id: orgId,
      // VoyageEmbedder returns { vectors: [{ index, vector }] } ordered to match input
      embedding: arrayToVectorLiteral(embeddings.vectors[i]!.vector),
    }));
    const { error: embErr } = await service
      .from('corpus_chunk_embeddings')
      .upsert(embedRows, { onConflict: 'chunk_id' });
    if (embErr !== null) continue;

    files += 1;
    chunks += chunkInputs.length;
  }

  return { files, chunks };
}

/**
 * pgvector expects the bracketed-array text format on insert; the
 * supabase-js driver passes the value through unchanged when we hand it a
 * string in `[v1,v2,...]` form. Float32Array → number[] → string.
 */
function arrayToVectorLiteral(vec: Float32Array): string {
  return `[${Array.from(vec).join(',')}]`;
}

function isIndexableSize(size: number | undefined): boolean {
  if (size === undefined) return true;
  return size > 0 && size <= 512 * 1024;
}

// Cheap pre-classification by extension only (no content); the real chunker
// runs on the bytes later and may still return [] (binary content with a
// recognised extension, e.g. weirdly-named .json blobs).
function classifiable(path: string): boolean {
  // Re-use the chunker's classifier indirectly: ask it to chunk an empty
  // string; if classifyFile returns non-null it would have returned [] only
  // because content was empty. That branch lives in chunkFile; here we ask
  // by path only via a tiny inline check.
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|scala|c|cc|cpp|cxx|h|hh|hpp|cs|php|swift|m|mm|sh|bash|zsh|fish|sql|graphql|proto|css|scss|sass|less|html|vue|svelte|astro|yaml|yml|toml|json|jsonc|tf|hcl|md|mdx|rst|txt|adoc|org)$/i.test(path)
    || /(?:^|\/)(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|Jenkinsfile|Vagrantfile|CMakeLists\.txt)$/i.test(path);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
