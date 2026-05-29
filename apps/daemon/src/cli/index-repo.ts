import { join } from 'node:path';
import { openCorpusDb } from '../corpus/db.js';
import { migrate } from '../corpus/migrate.js';
import { insertChunk, insertDoc } from '../corpus/query.js';
import { GithubClient } from '../connectors/github/client.js';
import { createGithubConnector } from '../connectors/github/index.js';
import { VoyageEmbedder } from '../embed/voyage.js';
import type { AuthResult } from '../connectors/contract.js';
import { getDataDir } from '../util/data-dir.js';
import { log, optionalEnv, requireEnv } from './util.js';

const EMBED_BATCH_SIZE = 64;

export async function runIndexRepo(args: readonly string[]): Promise<number> {
  const ownerRepo = args[0];
  if (ownerRepo === undefined || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(ownerRepo)) {
    log('error', 'Usage: upwell index <owner>/<repo>');
    return 2;
  }

  const githubToken = requireEnv('GITHUB_TOKEN');
  const voyageKey = requireEnv('VOYAGE_API_KEY');
  const indexFiles = optionalEnv('UPWELL_INDEX_FILES') !== 'false';

  const dataDir = getDataDir();
  const cacheDir = join(dataDir, 'cache', 'github');

  const auth: AuthResult = { kind: 'pat', token: githubToken };
  const client = new GithubClient({ logger: { log } });
  const connector = createGithubConnector({ client, cacheDir, indexFiles });
  const embedder = new VoyageEmbedder({
    apiKey: voyageKey,
    onUsage: (u) =>
      log('info', 'voyage.usage', {
        model: u.model,
        inputTokens: u.inputTokens,
        cacheHits: u.cacheHits,
      }),
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

    let embedded = 0;
    for (let i = 0; i < result.chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = result.chunks.slice(i, i + EMBED_BATCH_SIZE);
      const items = batch.map((c) => ({ text: c.text, domain: c.domain }));
      const embedResult = await embedder.embed({ items });
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const vector = embedResult.vectors[j]?.vector;
        if (vector === undefined) continue;
        insertChunk(db, { ...chunk, embedding: vector });
        embedded += 1;
      }
      if (embedded % 256 === 0 || i + EMBED_BATCH_SIZE >= result.chunks.length) {
        log(
          'info',
          `Embedded + indexed ${String(embedded)}/${String(result.chunks.length)} chunks.`,
        );
      }
    }
    log('info', `Index complete. ${String(embedded)} chunks embedded and stored.`);
  } finally {
    db.close();
  }
  return 0;
}
