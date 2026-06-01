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

  // Tier 2: whitespace-collapsed + NFC-normalized retry.
  const tier2 = matchNormalized(quote, body, false);
  if (tier2 !== null) return tier2;

  // Tier 3: also fold typographic punctuation (curly quotes → straight,
  // en/em dash → hyphen, ellipsis char). LLMs routinely re-punctuate a
  // copied span (a chunk has a straight quote; the model emits a curly
  // one, or vice versa). This is still character-faithful — no case
  // folding (kept per the "no lookalikes" policy), no edit distance.
  const tier3 = matchNormalized(quote, body, true);
  if (tier3 !== null) return tier3;

  // Tier 4: loose — drop apostrophes/quotes (model writes "user's", source has
  // "users"), treat any other punctuation as a word boundary, and fold case.
  // The alphanumeric token sequence must still appear contiguously, so this
  // tolerates "tidied" quotes without matching genuinely-different text. Must
  // mirror the backend verifier's loose tier so a verified quote highlights.
  return matchLoose(quote, body);
}

/** Loose, case-insensitive, punctuation-tolerant match (tier 4). Both quote
 *  and body collapse to lowercase alphanumeric tokens separated by single
 *  spaces (apostrophes/quotes dropped, other punctuation → boundary), so a
 *  re-punctuated quote still locates. Maps the hit back to raw-body offsets. */
function matchLoose(quote: string, body: string): QuoteMatch | null {
  const norm = looseNormalizeWithMap(body);
  const normalizedQuote = looseNormalizeString(quote);
  if (normalizedQuote.length === 0) return null;

  const normHit = norm.text.indexOf(normalizedQuote);
  if (normHit === -1) return null;

  const startRaw = norm.indexMap[normHit];
  const endRaw = norm.indexMap[normHit + normalizedQuote.length];
  if (startRaw === undefined || endRaw === undefined) return null;
  return { index: startRaw, length: endRaw - startRaw };
}

const ALNUM = /[a-z0-9]/i;
const DROPPED = /['’`"“”]/;

/** String-only loose normalization (for the query quote). */
function looseNormalizeString(s: string): string {
  let out = '';
  let prevSpace = true; // start as boundary so leading punctuation is trimmed
  for (const ch of s) {
    if (ALNUM.test(ch)) {
      out += ch.toLowerCase();
      prevSpace = false;
    } else if (DROPPED.test(ch)) {
      continue; // apostrophes/quotes vanish: user's -> users
    } else if (!prevSpace) {
      out += ' ';
      prevSpace = true;
    }
  }
  return prevSpace && out.endsWith(' ') ? out.slice(0, -1) : out;
}

/** Loose normalization of the body WITH an index map back to raw offsets. */
function looseNormalizeWithMap(raw: string): NormalizedWithMap {
  const chars: string[] = [];
  const indexMap: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ALNUM.test(ch)) {
      chars.push(ch.toLowerCase());
      indexMap.push(i);
      prevSpace = false;
    } else if (DROPPED.test(ch)) {
      continue;
    } else if (!prevSpace) {
      chars.push(' ');
      indexMap.push(i);
      prevSpace = true;
    }
  }
  while (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop();
    indexMap.pop();
  }
  indexMap.push(raw.length);
  return { text: chars.join(''), indexMap };
}

/** Whitespace/NFC (and optionally case+punctuation) normalized search,
 *  mapping the hit back to raw-body offsets. */
function matchNormalized(quote: string, body: string, fold: boolean): QuoteMatch | null {
  const norm = normalizeWithMap(body, fold);
  const normalizedQuote = normalize(quote, fold);
  if (normalizedQuote.length === 0) return null;

  const normHit = norm.text.indexOf(normalizedQuote);
  if (normHit === -1) return null;

  const startRaw = norm.indexMap[normHit];
  // endRaw is the raw index one PAST the match (indexMap has a sentinel).
  const endRaw = norm.indexMap[normHit + normalizedQuote.length];
  if (startRaw === undefined || endRaw === undefined) return null;

  return { index: startRaw, length: endRaw - startRaw };
}

/** Fold typographic punctuation to its ASCII equivalent for a single code
 *  point. Curly/straight quotes and en/em/minus dashes are the common LLM
 *  re-encodings. 1:1 (each input maps to one output) so the index map stays
 *  valid. No case folding — that's a deliberate policy (lookalike risk). */
function foldChar(ch: string): string {
  switch (ch) {
    case '‘':
    case '’':
    case '′':
    case '`':
      return "'";
    case '“':
    case '”':
    case '″':
      return '"';
    case '–':
    case '—':
    case '−':
      return '-';
    default:
      return ch;
  }
}

/**
 * Returns the normalized string only (no map). Used to normalize the
 * query quote — its index doesn't need to map back since we never
 * reference raw-quote indices.
 */
function normalize(s: string, fold = false): string {
  const nfc = s.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!fold) return nfc;
  let out = '';
  for (const ch of nfc) out += foldChar(ch);
  return out;
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
function normalizeWithMap(raw: string, fold = false): NormalizedWithMap {
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
    for (const c of normalizedCh) {
      const emitted = fold ? foldChar(c) : c;
      for (const out of emitted) {
        normalizedChars.push(out);
        indexMap.push(i);
      }
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
