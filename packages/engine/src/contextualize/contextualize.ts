// Contextual Retrieval (U3): generate a short LLM context per chunk that
// situates it within its source document, prepended to the embedded +
// lexically-indexed text. Anthropic's technique reduces retrieval failure
// markedly on corpora where the answer is scattered and chunks lose their
// surrounding context.
//
// The pure core (`contextualizeChunks`) takes an injected generator so it
// unit-tests without network; `makeAnthropicContextualizer` provides the
// production generator (full document in a prompt-cached block, so each
// chunk's call reuses it cheaply).

/** Given the full source document and one chunk's body, return a short
 *  context string (no body, just the situating context). */
export type ContextGenerator = (docText: string, chunkText: string) => Promise<string>;

/**
 * Produce a context string per chunk. An empty/whitespace chunk yields '' and
 * makes no LLM call. A generator failure for one chunk falls back to '' (the
 * chunk is still indexed body-only) so one bad call never sinks the doc.
 */
export async function contextualizeChunks(
  docText: string,
  chunkTexts: readonly string[],
  generate: ContextGenerator,
): Promise<string[]> {
  const out: string[] = [];
  for (const chunkText of chunkTexts) {
    if (chunkText.trim().length === 0) {
      out.push('');
      continue;
    }
    try {
      out.push((await generate(docText, chunkText)).trim());
    } catch {
      out.push('');
    }
  }
  return out;
}

/** The text fed to the embedder (and mirrored into the FTS column via the
 *  doc_chunks.context column): context + body, or just body when there's no
 *  context. */
export function contextualizedText(context: string, body: string): string {
  return context.length > 0 ? `${context}\n\n${body}` : body;
}
