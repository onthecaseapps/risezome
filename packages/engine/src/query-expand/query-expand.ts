// On-miss query expansion (U9, the CRAG fallback). When the first retrieval
// pass comes back empty/weak, ask Claude for candidate keywords, synonyms,
// and entity names that might appear in answer-bearing documents, then
// re-retrieve with the augmented query. Pays its cost only on a miss.
//
// Example: "what AI models are used" -> [Gemini, Claude, Haiku, GPT, OpenAI,
// Voyage, Deepgram, embeddings, transcription]. The pure core
// (`augmentQuery`) is trivially testable; the expander is the LLM call.

/** Expand a query into candidate terms (keywords / synonyms / entity names)
 *  that might appear in documents answering it. */
export type QueryExpander = (query: string) => Promise<string[]>;

/** Build the augmented query string: original query plus the de-duplicated
 *  expansion terms not already present (case-insensitive). */
export function augmentQuery(query: string, terms: readonly string[]): string {
  const present = new Set(query.toLowerCase().split(/\s+/));
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key) || present.has(key)) continue;
    seen.add(key);
    extra.push(trimmed);
  }
  return extra.length > 0 ? `${query} ${extra.join(' ')}` : query;
}
