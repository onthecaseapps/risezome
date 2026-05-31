import { join } from 'node:path';
import { openCorpusDb } from '../corpus/db.js';
import { migrate } from '../corpus/migrate.js';
import { hasChunkEmbedding, insertChunk, insertDoc } from '../corpus/query.js';
import { GithubClient } from '../connectors/github/client.js';
import { createGithubConnector } from '../connectors/github/index.js';
import { VoyageEmbedder, EmbeddingRateLimitError } from '@risezome/engine/embed';
import type { AuthResult } from '../connectors/contract.js';
import { getDataDir } from '../util/data-dir.js';
import { envInt, log, optionalEnv, requireEnv } from './util.js';

// Lowered from 64 because Voyage's free-tier 10,000 TPM limit means a 64-chunk
// batch (~200 tokens each ≈ 12.8k tokens) exceeds the per-minute token budget
// by itself. 24 chunks ≈ 4.8k tokens stays comfortably under.
const DEFAULT_EMBED_BATCH_SIZE = 24;

export async function runIndexRepo(args: readonly string[]): Promise<number> {
  const ownerRepo = args[0];
  if (ownerRepo === undefined || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ownerRepo)) {
    log('error', 'Usage: upwell index <owner>/<repo>');
    return 2;
  }

  const githubToken = requireEnv('GITHUB_TOKEN');
  const voyageKey = requireEnv('VOYAGE_API_KEY');
  const indexFiles = optionalEnv('RISEZOME_INDEX_FILES') !== 'false';

  const dataDir = getDataDir();
  const cacheDir = join(dataDir, 'cache', 'github');

  const auth: AuthResult = { kind: 'pat', token: githubToken };
  const client = new GithubClient({ logger: { log } });
  const connector = createGithubConnector({ client, cacheDir, indexFiles });
  const textModel = optionalEnv('VOYAGE_TEXT_MODEL');
  const codeModel = optionalEnv('VOYAGE_CODE_MODEL');
  const batchDelayMs = envInt('VOYAGE_BATCH_DELAY_MS', 0);
  const embedBatchSize = envInt('VOYAGE_EMBED_BATCH_SIZE', DEFAULT_EMBED_BATCH_SIZE);
  const embedder = new VoyageEmbedder({
    apiKey: voyageKey,
    ...(textModel !== undefined && { textModel }),
    ...(codeModel !== undefined && { codeModel }),
    batchDelayMs,
    onUsage: (u) =>
      log('info', 'voyage.usage', {
        model: u.model,
        inputTokens: u.inputTokens,
        cacheHits: u.cacheHits,
      }),
    onRetryWait: (r) =>
      log(
        'warn',
        `Voyage rate-limited. Waiting ${String(Math.round(r.waitMs / 1000))}s before retry ${String(r.attempt)}/${String(r.maxRetries)}…`,
        { reason: r.reason },
      ),
  });

  log('info', `Authenticating with GitHub as the holder of GITHUB_TOKEN…`);
  const outcome = await connector.authenticate(auth);
  if (!outcome.ok) {
    log('error', `GitHub auth failed: ${outcome.reason ?? 'unknown'}`, {
      missingScopes: [...outcome.missingScopes],
    });
    return 1;
  }
  log('info', `Authenticated as @${outcome.identity?.login ?? '?'}.`);

  const scope = {
    id: ownerRepo,
    displayName: ownerRepo,
    type: 'github-repo',
    metadata: { url: `https://github.com/${ownerRepo}` },
  };

  log('info', `Pulling delta from ${ownerRepo} (full clone + issues/PRs on first sync)…`);
  const result = await connector.pullDelta(auth, scope, null);
  log(
    'info',
    `Connector returned ${String(result.docs.length)} docs and ${String(result.chunks.length)} chunks.`,
  );

  if (result.docs.length === 0) {
    log('warn', `Nothing to index. Aborting.`);
    return 0;
  }

  const db = await openCorpusDb();
  await migrate(db);

  try {
    for (const doc of result.docs) insertDoc(db, doc);
    log('info', `Inserted ${String(result.docs.length)} docs.`);

    // Resume support: skip chunks already embedded in the corpus from a
    // previous (possibly partial) index run. Lets a rate-limited run recover
    // without re-sending what already went through Voyage.
    const allChunks = result.chunks;
    const remainingChunks = allChunks.filter((c) => !hasChunkEmbedding(db, c.chunkId));
    const skipped = allChunks.length - remainingChunks.length;
    if (skipped > 0) {
      log(
        'info',
        `Resume: ${String(skipped)}/${String(allChunks.length)} chunks already embedded in corpus; embedding the remaining ${String(remainingChunks.length)}.`,
      );
    }

    let embedded = skipped;
    try {
      for (let i = 0; i < remainingChunks.length; i += embedBatchSize) {
        const batch = remainingChunks.slice(i, i + embedBatchSize);
        const items = batch.map((c) => ({ text: c.text, domain: c.domain }));
        const embedResult = await embedder.embed({ items });
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j]!;
          const vector = embedResult.vectors[j]?.vector;
          if (vector === undefined) continue;
          insertChunk(db, { ...chunk, embedding: vector });
          embedded += 1;
        }
        log(
          'info',
          `Embedded + indexed ${String(embedded)}/${String(allChunks.length)} chunks (this run: ${String(i + batch.length)}/${String(remainingChunks.length)}).`,
        );
      }
    } catch (err) {
      if (err instanceof EmbeddingRateLimitError) {
        log(
          'error',
          `Voyage rate-limited after embedding ${String(embedded)}/${String(allChunks.length)} chunks. Try one of:`,
        );
        log('error', '  1) Re-run `pnpm daemon index <repo>` — already-embedded chunks are cached and only the remainder will be sent.');
        log('error', '  2) Add VOYAGE_BATCH_DELAY_MS=20000 to .env to throttle inter-batch sends (20s between batches).');
        log('error', '  3) Swap to a higher-rate-limit model with VOYAGE_TEXT_MODEL=<name> (see voyageai.com/docs).');
        log('error', '  4) Upgrade your Voyage tier (free tier is per-minute; paid tier is per-second).');
        return 1;
      }
      throw err;
    }
    log(
      'info',
      `Index complete. ${String(embedded)} chunks embedded and stored (${String(skipped)} reused from previous run).`,
    );
  } finally {
    db.close();
  }
  return 0;
}
