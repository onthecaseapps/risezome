// Parent-document (small-to-big) retrieval (U8).
//
// Chunks are embedded small for precise matching, but a small winning chunk is
// context-starved for synthesis — it arrives as a fragment without the
// surrounding explanation. This expands a winning child chunk to the context a
// synthesizer needs, while citations still point at the precise child.
//
// Strategy: capped-parent with window fallback.
//   - If the whole parent doc fits under `capChars`, return the whole doc.
//   - Otherwise return the child ± `windowRadius` neighbouring chunks (by
//     position), joined and capped — enough local context without blowing the
//     synthesis budget on a large doc.
//   - No siblings (or the child isn't among them) → return the child alone.

/** One body chunk of a document. `position` is the chunk's order within the
 *  doc (doc_chunks.position); summary chunks are excluded by the caller. */
export interface DocChunkPiece {
  readonly position: number;
  readonly text: string;
}

export interface ParentExpandOptions {
  /** Max characters of the whole-doc form before falling back to a window. */
  readonly capChars: number;
  /** Neighbours to include on each side of the child in the window fallback. */
  readonly windowRadius: number;
}

const SEP = '\n\n';

/**
 * Expand a winning child chunk to parent context. Pure + deterministic so it
 * can be unit-tested without a DB. `siblings` are all body chunks of the
 * child's parent doc (any order; should include the child itself). The
 * returned text is what the synthesizer sees; the caller keeps the child's
 * identity for the citation.
 */
export function expandToParent(args: {
  readonly childText: string;
  readonly childPosition: number;
  readonly siblings: readonly DocChunkPiece[];
  readonly options: ParentExpandOptions;
}): string {
  const { childText, childPosition, siblings, options } = args;
  if (siblings.length === 0) return childText;

  const ordered = [...siblings].sort((a, b) => a.position - b.position);
  const whole = ordered.map((c) => c.text).join(SEP);
  if (whole.length <= options.capChars) return whole;

  // Doc too big for the whole-doc form — return a window around the child.
  const window = ordered.filter(
    (c) => Math.abs(c.position - childPosition) <= options.windowRadius,
  );
  if (window.length === 0) return childText; // child not among siblings
  const joined = window.map((c) => c.text).join(SEP);
  return joined.length <= options.capChars ? joined : joined.slice(0, options.capChars);
}
