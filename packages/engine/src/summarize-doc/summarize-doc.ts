// Per-document summarization (U6): condense a source document into a compact
// "what this is + key facts" paragraph, indexed as a distinguished summary
// chunk so a high-level question ("what AI models are used") can hit one
// consolidating chunk instead of needing to assemble scattered ones.
//
// Distinct from the rolling meeting summarizer (packages/engine/summarize)
// and from per-chunk contextualization (packages/engine/contextualize): this
// summarizes a whole indexed document at index time.

/** Summarize a whole document into a short, fact-dense paragraph. Returns ''
 *  to signal "no summary" (caller skips the summary chunk). */
export type DocSummarizer = (docText: string, title: string) => Promise<string>;

/** Generate a summary for one document, swallowing failures to '' so a bad
 *  summary call never blocks the document's body chunks from indexing. */
export async function summarizeDoc(
  docText: string,
  title: string,
  summarize: DocSummarizer,
): Promise<string> {
  if (docText.trim().length === 0) return '';
  try {
    return (await summarize(docText, title)).trim();
  } catch {
    return '';
  }
}
