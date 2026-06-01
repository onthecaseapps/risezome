/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit` calls
 * in flight at once, preserving input order in the result array.
 *
 * Used by the indexers to parallelize per-document enrichment (Contextual
 * Retrieval + summary LLM calls + embed + DB write) across the docs in a
 * batch. Each doc is independent — distinct docId, distinct prompt-cache
 * block — so concurrent processing is safe and is the dominant wall-clock win
 * for a reindex (the LLM calls per doc are otherwise run strictly serially).
 *
 * Per-chunk contextualization inside a single doc stays sequential by design
 * (see contextualizeChunks): the first call warms the doc's prompt cache and
 * the rest read it; firing them concurrently would race ahead of that write.
 *
 * Error semantics mirror the prior sequential loops: the first rejection
 * propagates (rejecting this call), so a rate-limit or changed-doc failure
 * still fails the Inngest step and triggers a retry. In-flight tasks that
 * already committed their doc are covered by skip-unchanged on retry.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const cap = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(cap, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
