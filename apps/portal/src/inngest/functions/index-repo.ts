import { Buffer } from 'node:buffer';
import { chunkFile } from '@risezome/engine/chunker';
import {
  contextualizeChunks,
  contextualizedText,
  type ContextGenerator,
} from '@risezome/engine/contextualize';
import { summarizeDoc, type DocSummarizer } from '@risezome/engine/summarize-doc';
import { optionalContextGenerator, optionalDocSummarizer, docConcurrency } from '../lib/contextualizer';
import { mapWithConcurrency } from '../lib/concurrency';
import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import { inngest, type IndexMode } from '../client';
import { createServiceRoleClient } from '../../../app/_lib/supabase-server';
import { orgScopedDocId } from '../../../app/_lib/doc-id';
import { sanitizeStatusMessage } from '../lib/status-message';
import { getInstallationOctokit } from '../../../app/_lib/github-app';
import { reconcile, writeReconciledDoc } from '../lib/corpus-reconcile';

/** Doc types this indexer owns — reconcile must never touch issue/PR docs
 *  that share this source_id (see corpus-reconcile R8). */
const OWNED_TYPES = ['file'];

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
    // Safety net: when all retries are exhausted, flip the source to
    // `errored` instead of leaving it wedged at `indexing` (which grays
    // out the Reindex button forever). Any failure cause — deleted
    // default branch, revoked token, network — self-heals to a
    // retryable state.
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
    const { orgId, sourceId, mode } = (event as unknown as {
      data: { orgId: string; sourceId: string; mode?: IndexMode };
    }).data;
    const indexMode: IndexMode = mode === 'full' ? 'full' : 'delta';

    // ── Step 1: look up source + installation, mark indexing ─────────
    const source = await step.run('load-source', async () => {
      const service = createServiceRoleClient();
      const { data, error } = await service
        .from('sources')
        .select('id, org_id, installation_id, repo_full_name, repo_id, default_branch, status')
        .eq('id', sourceId)
        .eq('org_id', orgId)
        .single();
      if (error !== null || data === null) {
        throw new Error(`source not found: org=${orgId} source=${sourceId} (${error?.message ?? 'no row'})`);
      }
      // A queued index event can arrive after the repo was deselected
      // (status='removed', awaiting purge) — skip rather than re-index it.
      if ((data as { status: string }).status === 'removed') return null;
      await service
        .from('sources')
        .update({
          status: 'indexing',
          status_message: null,
          indexed_files: 0,
          total_files: null,
          chunk_count: 0,
        })
        .eq('id', sourceId)
        .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        .neq('status', 'removed'); // removal is sticky (deselect↔index race)
      return data as {
        id: string;
        org_id: string;
        installation_id: number;
        repo_full_name: string;
        repo_id: number | null;
        default_branch: string | null;
      };
    });
    if (source === null) {
      return { sourceId, files: 0, chunks: 0, skipped: 'removed' };
    }

    const [owner, repo] = source.repo_full_name.split('/');
    if (owner === undefined || repo === undefined) {
      throw new Error(`malformed repo_full_name: ${source.repo_full_name}`);
    }

    // ── Step 2: resolve default branch + list tree ───────────────────
    const tree = await step.run('fetch-tree', async () => {
      const octokit = await getInstallationOctokit(source.installation_id);

      // Resolve the repo's current default branch from GitHub and persist it.
      const resolveDefaultBranch = async (): Promise<string> => {
        const repoResp = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        const live = (repoResp.data as { default_branch: string }).default_branch;
        await createServiceRoleClient()
          .from('sources')
          .update({ default_branch: live })
          .eq('id', sourceId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        return live;
      };
      const fetchTreeSha = async (b: string): Promise<string> => {
        const branchResp = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
          owner,
          repo,
          branch: b,
        });
        return (branchResp.data as { commit: { commit: { tree: { sha: string } } } }).commit.commit.tree.sha;
      };

      let branch = source.default_branch;
      if (branch === null || branch.length === 0) branch = await resolveDefaultBranch();

      // Resolve branch → tree sha. The recursive flag may truncate at ~100k
      // entries; we accept truncation for V1 (no monorepos at beta scale).
      // If the stored branch was renamed or deleted (e.g. a feature branch that
      // got merged and pruned), GET branches 404s — re-resolve the repo's live
      // default branch once and retry instead of failing the run forever.
      let treeSha: string;
      try {
        treeSha = await fetchTreeSha(branch);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
        branch = await resolveDefaultBranch();
        treeSha = await fetchTreeSha(branch);
      }

      const treeResp = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
        owner,
        repo,
        tree_sha: treeSha,
        recursive: 'true',
      });

      type TreeEntry = { path: string; type: string; size?: number; sha: string };
      const treeData = treeResp.data as { tree: TreeEntry[]; truncated: boolean };
      const blobs = treeData.tree.filter((e) => e.type === 'blob');
      // `truncated` (GitHub caps the recursive tree at ~100k entries)
      // means the desired set is incomplete — reconcile must NOT prune on
      // a truncated tree or live files get deleted as phantom removals.
      return { branch, treeSha, blobs, truncated: treeData.truncated === true };
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
      await createServiceRoleClient()
        .from('sources')
        .update({ total_files: totalFiles })
        .eq('id', sourceId)
        .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
    });

    // ── Step 4: reconcile — diff the tree against the corpus ─────────
    // Desired = the current tree's files keyed by content-addressed docId
    // (the blob SHA is an exact content hash). reconcile skips unchanged
    // files (already present), returns new/changed to index, and — on a
    // complete (non-truncated) tree, in BOTH delta and full mode — prunes
    // files the repo no longer has. Delta must prune here too: an edited
    // file gets a NEW content-addressed docId, so the previous `…@oldsha`
    // version is only ever removed by the prune, and delta is the default
    // mode — gating prune on full would accumulate stale file versions
    // forever (see corpus-reconcile "Delta-prune-on-complete-fetch").
    // Type-scoped to 'file' so it never touches the issue/PR docs that
    // share this source_id.
    const fetchComplete = !tree.truncated;
    // The blob SHA fingerprints the file CONTENT but not the chunking
    // config — without folding the chunker mode into the hash, flipping
    // RISEZOME_CODE_STRUCTURE_CHUNKING would never re-chunk existing files
    // (reconcile sees an unchanged hash and skips them), so the flag would
    // silently do nothing for an already-indexed repo.
    const structureChunking = process.env.RISEZOME_CODE_STRUCTURE_CHUNKING === 'true';
    const hashOf = (sha: string): string => (structureChunking ? `${sha}:cs1` : sha);
    const desired = new Map(
      targets.map((t) => [orgScopedDocId(orgId, `github:${owner}/${repo}:${t.path}@${t.sha}`), { hash: hashOf(t.sha) }] as const),
    );
    const recon = await step.run('reconcile', async () => {
      const r = await reconcile(createServiceRoleClient(), {
        sourceId,
        ownedTypes: OWNED_TYPES,
        desired,
        mode: indexMode,
        fetchComplete,
        // A genuinely empty repo (no indexable files, tree not truncated)
        // is a confirmed-empty source → safe to prune to zero.
        confirmedEmpty: targets.length === 0 && fetchComplete,
      });
      // Progress baseline: unchanged files are already covered, so surface
      // them now. Without this the counter sits at 0 through the whole
      // tree-fetch/reconcile phase and then leaps to ~unchanged when the
      // first batch lands ("0 of 803 … suddenly 600").
      await createServiceRoleClient()
        .from('sources')
        .update({ indexed_files: r.counts.unchanged })
        .eq('id', sourceId)
        .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        .neq('status', 'removed');
      return r;
    });

    if (recon.toIndex.length === 0) {
      await step.run('finalize-no-index', async () => {
        await createServiceRoleClient()
          .from('sources')
          .update({
            status: 'idle',
            last_indexed_at: new Date().toISOString(),
            indexed_files: totalFiles,
          })
          .eq('id', sourceId)
          .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
          // Removal is sticky: a deselect that landed mid-run must survive
          // this write or the purge cron never matches the source.
          .neq('status', 'removed');
      });
      console.info(
        `[index-repo] ${source.repo_full_name} (${indexMode}): ` +
          `${String(recon.counts.unchanged)} unchanged, ${String(recon.counts.removed)} removed, 0 to index`,
      );
      return { sourceId, files: 0, chunks: 0, ...recon.counts };
    }

    // ── Step 5: batched embed + write (only new/changed files) ───────
    const toIndexKind = new Map(recon.toIndex.map((t) => [t.docId, t.kind]));
    const indexTargets = targets.filter((t) =>
      toIndexKind.has(orgScopedDocId(orgId, `github:${owner}/${repo}:${t.path}@${t.sha}`)),
    );
    // Files per Inngest step. One step per batch (counter folded in below)
    // must keep big repos under Inngest's ~1000-step cap; 40 covers ~40k files.
    const BATCH_SIZE = 40;
    const embedder = new VoyageEmbedder({
      apiKey: requireEnv('VOYAGE_API_KEY'),
    });
    const contextGenerator = optionalContextGenerator();
    const docSummarizer = optionalDocSummarizer();

    let indexedFiles = recon.counts.unchanged; // unchanged already count as covered
    let chunkCount = 0;
    for (let i = 0; i < indexTargets.length; i += BATCH_SIZE) {
      const batch = indexTargets.slice(i, i + BATCH_SIZE);
      // Cumulative totals BEFORE this batch — deterministic on replay (they
      // are rebuilt from memoized step results), so folding the counter
      // update into the batch step is safe.
      const filesBefore = indexedFiles;
      const chunksBefore = chunkCount;
      const result = await step.run(`index-batch-${i}`, async () => {
        const r = await indexBatch({
          batch: batch.map((t) => ({
            ...t,
            kind: toIndexKind.get(orgScopedDocId(orgId, `github:${owner}/${repo}:${t.path}@${t.sha}`)) ?? 'new',
          })),
          orgId,
          sourceId,
          owner,
          repo,
          branch: tree.branch,
          installationId: source.installation_id,
          embedder,
          contextGenerator,
          docSummarizer,
          structureChunking,
        });
        // Counter update folded into the batch step (one step per batch keeps
        // big repos under Inngest's ~1000-step cap).
        await createServiceRoleClient()
          .from('sources')
          .update({
            indexed_files: filesBefore + r.files,
            chunk_count: chunksBefore + r.chunks,
          })
          .eq('id', sourceId)
          .eq('org_id', orgId); // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        return r;
      });
      indexedFiles += result.files;
      chunkCount += result.chunks;
    }

    // ── Step 6: mark idle ────────────────────────────────────────────
    await step.run('finalize', async () => {
      await createServiceRoleClient()
        .from('sources')
        .update({ status: 'idle', last_indexed_at: new Date().toISOString(), indexed_files: totalFiles })
        .eq('id', sourceId)
        .eq('org_id', orgId) // defense-in-depth: service-role bypasses RLS, scope by org explicitly
        // Removal is sticky: a deselect that landed mid-run must survive
        // this write or the purge cron never matches the source.
        .neq('status', 'removed');
    });

    console.info(
      `[index-repo] ${source.repo_full_name} (${indexMode}): ` +
        `new=${String(recon.counts.new)} changed=${String(recon.counts.changed)} ` +
        `unchanged=${String(recon.counts.unchanged)} removed=${String(recon.counts.removed)} ` +
        `chunks=${String(chunkCount)}`,
    );
    return { sourceId, files: indexedFiles, chunks: chunkCount, ...recon.counts };
  },
);

// ── Helpers ────────────────────────────────────────────────────────

async function indexBatch(args: {
  batch: Array<{ path: string; sha: string; size?: number; kind: 'new' | 'changed' }>;
  orgId: string;
  sourceId: string;
  owner: string;
  repo: string;
  branch: string;
  installationId: number;
  embedder: VoyageEmbedder;
  contextGenerator: ContextGenerator | undefined;
  docSummarizer: DocSummarizer | undefined;
  /** Caller's chunking mode — MUST be the same value used to build the
   *  desired-hash map, or stored hashes drift from desired and every run
   *  re-indexes everything (or never re-chunks). */
  structureChunking: boolean;
}): Promise<{ files: number; chunks: number }> {
  const { batch, orgId, sourceId, owner, repo, branch, installationId, embedder, contextGenerator, docSummarizer, structureChunking } = args;
  const octokit = await getInstallationOctokit(installationId);
  const service = createServiceRoleClient();

  const perFile = await mapWithConcurrency(batch, docConcurrency(), async (entry) => {
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
      if (data.type !== 'file' || data.content === undefined) return { files: 0, chunks: 0 };
      content = Buffer.from(data.content, 'base64').toString('utf8');
    } catch {
      // 404 / 403 → skip this file. Don't fail the whole run for one bad path.
      return { files: 0, chunks: 0 };
    }

    const chunkInputs = chunkFile(entry.path, content, { codeStructureAware: structureChunking });
    if (chunkInputs.length === 0) return { files: 0, chunks: 0 };

    // Contextual Retrieval (U3): per-chunk context from the full file,
    // prepended to the embedded text; verbatim body stays in `text`,
    // context folded into text_fts via the doc_chunks.context column.
    const contexts =
      contextGenerator !== undefined
        ? await contextualizeChunks(content, chunkInputs.map((c) => c.text), contextGenerator)
        : chunkInputs.map(() => '');
    // Per-document (per-file) summary chunk (U6), excluded from content_hash
    // (the file's blob SHA stays the change fingerprint).
    const summary =
      docSummarizer !== undefined ? await summarizeDoc(content, entry.path, docSummarizer) : '';

    const embedItems = chunkInputs.map((c, i) => ({
      id: `${entry.sha}::${i}`,
      text: contextualizedText(contexts[i] ?? '', c.text),
      domain: c.domain,
    }));
    if (summary.length > 0) {
      embedItems.push({ id: `${entry.sha}::summary`, text: summary, domain: 'text' });
    }

    // Embed all chunks for this file in one request to amortize HTTP overhead.
    let embeddings;
    try {
      embeddings = await embedder.embed({ items: embedItems });
    } catch (err) {
      if (err instanceof EmbeddingRateLimitError) throw err; // let Inngest retry
      // Other embed errors on a NEW doc: skip the file, keep going —
      // nothing has been written yet, so the doc is simply absent and the
      // next run retries it. A CHANGED doc must throw instead (mirrors
      // connector-index): skipping would leave the stale version pending
      // behind a transient error with nothing forcing the re-embed.
      if (entry.kind === 'changed') {
        throw new Error(`github embed failed for changed ${entry.path}: ${String(err)}`);
      }
      return { files: 0, chunks: 0 };
    }

    const docId = orgScopedDocId(orgId, `github:${owner}/${repo}:${entry.path}@${entry.sha}`);
    // chunkRows and embedItems are in the same order (body chunks, then the
    // optional summary), so vectors[i] aligns with writeChunks[i].
    const writeChunks: Array<{
      chunkId: string;
      domain: string;
      text: string;
      context: string;
      isSummary?: boolean;
      position: number;
    }> = chunkInputs.map((c, i) => ({
      chunkId: `${docId}::${i}`,
      domain: c.domain,
      text: c.text,
      context: contexts[i] ?? '',
      position: i,
    }));
    if (summary.length > 0) {
      writeChunks.push({
        chunkId: `${docId}::summary`,
        domain: 'text',
        text: summary,
        context: '',
        isSummary: true,
        position: chunkInputs.length,
      });
    }

    // Atomic write protocol (F5) via writeReconciledDoc: clear-on-changed →
    // doc upsert with content_hash NULL → chunks → embeddings → stamp the
    // hash LAST, throwing on any DB error so Inngest retries. The previous
    // inline version stamped the hash up front and swallowed chunk/embedding
    // errors — one transient failure left a doc whose hash said "indexed"
    // with zero chunks, which reconcile then classified as unchanged forever.
    // (A 'changed' file is content-addressed → a brand-new docId, so that
    // kind is effectively dead for files; handled anyway for correctness if
    // the docId scheme ever becomes path-stable.)
    await writeReconciledDoc(service, {
      docId,
      kind: entry.kind,
      // content_hash = blob SHA + chunking-config fingerprint; must mirror
      // the desired-hash map exactly (see hashOf in the handler).
      hash: structureChunking ? `${entry.sha}:cs1` : entry.sha,
      doc: {
        orgId,
        sourceId,
        source: 'github',
        type: 'file',
        title: entry.path,
        url: `https://github.com/${owner}/${repo}/blob/${branch}/${entry.path}`,
        provenance: 'trusted',
        updatedAt: new Date().toISOString(),
      },
      chunks: writeChunks,
      embeddings: writeChunks.map((_, i) => arrayToVectorLiteral(embeddings.vectors[i]!.vector)),
    });

    return { files: 1, chunks: chunkInputs.length };
  });

  return perFile.reduce(
    (acc, r) => ({ files: acc.files + r.files, chunks: acc.chunks + r.chunks }),
    { files: 0, chunks: 0 },
  );
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
