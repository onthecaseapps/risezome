// Direct-Postgres corpus writer.
//
// The hosted Supabase REST endpoint (PostgREST) sits behind Cloudflare's
// managed WAF. Indexer writes ship raw source-file content in the
// `doc_chunks.text` body; some chunks (e.g. inline HTML/JSX/`<script>` in a
// React file) match a managed XSS signature, so the WAF 403s the upsert with
// an "Attention Required" challenge page BEFORE PostgREST runs. The block is
// deterministic, so retries can't help.
//
// The indexer is a trusted backend job, so it has no business routing bulk
// content through an edge WAF tuned for untrusted browser traffic. This module
// writes corpus rows over a direct Postgres connection (Supavisor pooler),
// which has no Cloudflare in front of it. The connection bypasses RLS as the
// `postgres` role exactly as the service-role REST client did, so every
// statement stays explicitly org-scoped as defense-in-depth.
//
// Bonus: each document is written in a single transaction, so the F5
// "stamp content_hash last" dance becomes redundant — a crash mid-write rolls
// back atomically instead of leaving a half-written doc that reads as
// unchanged.

import postgres, { type Sql, type JSONValue } from 'postgres';
import type { CorpusWriteClient, ReconciledDocWrite } from './corpus-reconcile.js';

let sql: Sql | undefined;

/**
 * Lazily open (and memoize) the pooled Postgres connection. Reused across warm
 * serverless invocations. `prepare: false` keeps it compatible with the
 * Supavisor transaction pooler (port 6543), which doesn't support prepared
 * statements; it's harmless on the session pooler too.
 */
export function getCorpusSql(): Sql {
  if (sql !== undefined) return sql;
  const url = process.env.SUPABASE_DB_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'SUPABASE_DB_URL is not set — the corpus indexer writes via a direct Postgres ' +
        'connection (the Supabase transaction-pooler connection string) to bypass the ' +
        'REST/Cloudflare WAF. Set it to the pooler URI including the database password.',
    );
  }
  sql = postgres(url, {
    prepare: false,
    ssl: 'require',
    max: 4,
    idle_timeout: 20,
    connect_timeout: 15,
    // Identifies the connection in pg_stat_activity / logs.
    connection: { application_name: 'risezome-indexer' },
  });
  return sql;
}

/** Transient connection failures worth a retry (the WAF is gone, but a pooled
 *  connection can still drop). Genuine SQL errors (constraint, type) don't
 *  match and fail fast. Exported for unit testing. */
export const TRANSIENT_PG_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|connection.*(closed|terminated|timed out)|terminating connection|terminat\w+ unexpectedly|server conn\w* closed|too many connections|Connection ended/i;

const WRITE_RETRY_DELAYS_MS: readonly number[] = [500, 2000, 6000];

async function withRetry<T>(label: string, op: () => Promise<T>, delays = WRITE_RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!TRANSIENT_PG_ERROR_RE.test(message) || attempt >= delays.length) {
        throw err instanceof Error ? err : new Error(`${label}: ${message}`);
      }
      console.warn(
        `[corpus-pg] transient connection failure (attempt ${String(attempt + 1)}/${String(delays.length + 1)}), retrying ${label}`,
      );
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/**
 * Production CorpusWriteClient over direct Postgres. `client` defaults to the
 * memoized pooled connection; tests inject an in-memory `postgres` mock or a
 * fake CorpusWriteClient at the call site instead.
 */
export function pgCorpusWriter(client?: Sql): CorpusWriteClient {
  const db = (): Sql => client ?? getCorpusSql();

  return {
    async writeDoc(w: ReconciledDocWrite): Promise<void> {
      if (w.chunks.length !== w.embeddings.length) {
        throw new Error(`pgCorpusWriter.writeDoc: chunk/embedding length mismatch for ${w.docId}`);
      }
      await withRetry(`writeDoc ${w.docId}`, () =>
        db().begin(async (tx) => {
          // CHANGED → drop stale chunks first (cascade clears embeddings) so a
          // shrunk doc leaves no trailing-position orphans. The whole write is
          // one transaction, so this is safe even on a crash mid-write.
          if (w.kind === 'changed') {
            await tx`delete from public.doc_chunks where org_id = ${w.doc.orgId} and doc_id = ${w.docId}`;
          }

          // Doc row. content_hash is written here directly (no two-phase
          // null-then-stamp): the transaction commits atomically.
          await tx`
            insert into public.docs (id, org_id, source_id, source, type, title, body_summary,
                                     entities, authors, url, provenance, updated_at, content_hash)
            values (${w.docId}, ${w.doc.orgId}, ${w.doc.sourceId}, ${w.doc.source}, ${w.doc.type},
                    ${w.doc.title}, ${w.doc.bodySummary ?? ''},
                    ${tx.json((w.doc.entities ?? []) as JSONValue)}, ${tx.json((w.doc.authors ?? []) as JSONValue)},
                    ${w.doc.url}, ${w.doc.provenance}, ${w.doc.updatedAt}, ${w.hash})
            on conflict (id) do update set
              org_id = excluded.org_id, source_id = excluded.source_id, source = excluded.source,
              type = excluded.type, title = excluded.title, body_summary = excluded.body_summary,
              entities = excluded.entities, authors = excluded.authors, url = excluded.url,
              provenance = excluded.provenance, updated_at = excluded.updated_at,
              content_hash = excluded.content_hash`;

          if (w.chunks.length === 0) return;

          // Multi-row chunk + embedding inserts via unnest, so one round-trip
          // each regardless of chunk count. The embedding literal is cast
          // text -> vector explicitly.
          const chunkIds = w.chunks.map((c) => c.chunkId);
          const domains = w.chunks.map((c) => c.domain);
          const texts = w.chunks.map((c) => c.text);
          const contexts = w.chunks.map((c) => c.context ?? '');
          const isSummary = w.chunks.map((c) => c.isSummary ?? false);
          const positions = w.chunks.map((c) => c.position);

          await tx`
            insert into public.doc_chunks (chunk_id, org_id, source_id, doc_id, domain, text, context, is_summary, position)
            select c, ${w.doc.orgId}, ${w.doc.sourceId}, ${w.docId}, d, t, x, s, p
            from unnest(${chunkIds}::text[], ${domains}::text[], ${texts}::text[],
                        ${contexts}::text[], ${isSummary}::bool[], ${positions}::int[]) as u(c, d, t, x, s, p)
            on conflict (chunk_id) do update set
              org_id = excluded.org_id, source_id = excluded.source_id, doc_id = excluded.doc_id,
              domain = excluded.domain, text = excluded.text, context = excluded.context,
              is_summary = excluded.is_summary, position = excluded.position`;

          // Embeddings per-row: the literal is bound as an unspecified param
          // so `${lit}::vector` parses via pgvector's input function. (Going
          // through unnest(...::text[]) would type the element as `text`,
          // which has no guaranteed cast to `vector`.) N is the chunk count
          // per doc (small), all inside the one transaction.
          for (let i = 0; i < w.chunks.length; i += 1) {
            await tx`
              insert into public.corpus_chunk_embeddings (chunk_id, org_id, source_id, domain, embedding)
              values (${w.chunks[i]!.chunkId}, ${w.doc.orgId}, ${w.doc.sourceId}, ${w.chunks[i]!.domain}, ${w.embeddings[i]!}::vector)
              on conflict (chunk_id) do update set
                org_id = excluded.org_id, source_id = excluded.source_id,
                domain = excluded.domain, embedding = excluded.embedding`;
          }
        }),
      );
    },

    async clearChunks(docId: string, orgId: string): Promise<void> {
      await withRetry(`clearChunks ${docId}`, async () => {
        await db()`delete from public.doc_chunks where org_id = ${orgId} and doc_id = ${docId}`;
      });
    },
  };
}
