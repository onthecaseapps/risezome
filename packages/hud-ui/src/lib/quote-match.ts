/**
 * Locate an LLM-emitted citation quote within a source body, returning
 * the raw-body index + length so the caller can wrap the matched span
 * in a `<mark>` (or equivalent).
 *
 * Two-tier strategy (plan U3 + S5 from review):
 *
 *   1. Raw `String.prototype.indexOf(quote, body)` — case-sensitive,
 *      exact. The cheap path that catches the majority of LLM outputs
 *      where Claude faithfully copied the source.
 *
 *   2. Whitespace + Unicode normalized retry. The LLM often re-encodes
 *      whitespace (collapses runs, swaps tabs for spaces, drops line
 *      breaks) or normalizes typographic punctuation (curly quotes,
 *      em-dashes, ellipsis). Both transforms are character-faithful —
 *      no edit distance, no token overlap — so this stays within the
 *      "quiet beats wrong" V1 policy (the brainstorm's case-insensitive
 *      tier was explicitly dropped to avoid false-positive lookalikes).
 *
 * Returns `null` on miss; the caller renders the body without a
 * highlight (R8: no error UI). Returns `{index, length}` on hit,
 * where both are offsets into the ORIGINAL `body` string, not the
 * normalized form — that way the caller can `body.slice()` directly.
 *
 * Pure function. No DOM access, no React. Importable from non-component
 * code (engine telemetry, server-side rendering, future review-page
 * highlights).
 */
export interface QuoteMatch {
  /** Character offset into the original body where the match starts. */
  readonly index: number;
  /** Length in original body characters (NOT normalized characters). */
  readonly length: number;
}

export function findQuoteInBody(
  quote: string | undefined,
  body: string,
): QuoteMatch | null {
  if (quote === undefined || quote.length === 0 || body.length === 0) return null;

  // Tier 1: raw indexOf.
  const raw = body.indexOf(quote);
  if (raw !== -1) return { index: raw, length: quote.length };

  // Tier 2: whitespace-collapsed + NFC-normalized retry. Build a map
  // from normalized-character index back to raw-character index so the
  // hit position translates back to the original body.
  const norm = normalizeWithMap(body);
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length === 0) return null;

  const normHit = norm.text.indexOf(normalizedQuote);
  if (normHit === -1) return null;

  const startRaw = norm.indexMap[normHit];
  const endNormExclusive = normHit + normalizedQuote.length;
  // endRaw is the raw index of the character one PAST the match.
  // indexMap is length normText + 1 to give us this sentinel.
  const endRaw = norm.indexMap[endNormExclusive];
  if (startRaw === undefined || endRaw === undefined) return null;

  return { index: startRaw, length: endRaw - startRaw };
}

/**
 * Returns the normalized string only (no map). Used to normalize the
 * query quote — its index doesn't need to map back since we never
 * reference raw-quote indices.
 */
function normalize(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

interface NormalizedWithMap {
  /** Normalized text: NFC + whitespace runs collapsed + leading/trailing trimmed. */
  readonly text: string;
  /** Maps normalized-char index → raw-char index. Length = text.length + 1
   *  (the last entry is the raw index just past the final normalized char,
   *  so callers can slice an exclusive end). */
  readonly indexMap: readonly number[];
}

/**
 * Normalize `body` while building an index map so a hit position in the
 * normalized string can be translated back to a slice in the original.
 *
 * Per-character walk:
 *   - NFC-normalize each character (single combining sequence becomes
 *     one normalized character; multi-char inputs become one for ñ-style
 *     decomposed forms).
 *   - Collapse runs of whitespace into a single space.
 *   - Trim leading whitespace (no normalized chars are emitted until the
 *     first non-whitespace character).
 *
 * Trailing whitespace handling: emitted up to the last non-whitespace,
 * matching the `.trim()` in `normalize(quote)` so both sides agree on
 * boundaries.
 */
function normalizeWithMap(raw: string): NormalizedWithMap {
  const normalizedChars: string[] = [];
  const indexMap: number[] = [];

  let inWhitespaceRun = false;
  let hasEmittedNonWhitespace = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const isWs = /\s/.test(ch);
    if (isWs) {
      if (hasEmittedNonWhitespace && !inWhitespaceRun) {
        // First whitespace after non-whitespace: emit one space.
        normalizedChars.push(' ');
        indexMap.push(i);
        inWhitespaceRun = true;
      }
      // Else: leading whitespace (drop) or inside a run (collapse).
      continue;
    }
    // Non-whitespace: NFC-normalize the single char. Surrogate pairs
    // and combining sequences require iterating with the string-iterator
    // form; for simplicity here we normalize the single code unit and
    // rely on .normalize being a no-op for already-NFC content.
    const normalizedCh = ch.normalize('NFC');
    for (const out of normalizedCh) {
      normalizedChars.push(out);
      indexMap.push(i);
    }
    inWhitespaceRun = false;
    hasEmittedNonWhitespace = true;
  }

  // Drop any trailing single-space emitted before raw-end whitespace runs.
  while (
    normalizedChars.length > 0 &&
    normalizedChars[normalizedChars.length - 1] === ' '
  ) {
    normalizedChars.pop();
    indexMap.pop();
  }

  // Sentinel: one past the last normalized char maps to raw.length (end-
  // exclusive). Lets callers compute a slice end without a +1 dance.
  indexMap.push(raw.length);

  return { text: normalizedChars.join(''), indexMap };
}
