import { chunkIsMeaningful, MIN_CHUNK_CHARS } from './chunk-shared.js';

export interface MarkdownChunk {
  readonly index: number;
  readonly heading: string | null;
  readonly text: string;
}

export interface ChunkMarkdownOptions {
  readonly maxChunkChars?: number;
  /**
   * Override the global meaningful-chunk floor. Tests use this; production
   * callers should let the shared MIN_CHUNK_CHARS apply.
   */
  readonly minChunkChars?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 1_500;

/**
 * Split markdown into chunks bounded by H2-and-deeper headings; oversized
 * sections fall back to fixed-size windows so a single huge section doesn't
 * blow the embedding budget. The H1/title heading is preserved verbatim in
 * the leading chunk's text but does not act as a split point so the doc's
 * overall topic stays attached to its intro.
 */
export function chunkMarkdown(text: string, options: ChunkMarkdownOptions = {}): MarkdownChunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const minChunkChars = options.minChunkChars ?? MIN_CHUNK_CHARS;
  if (text.trim().length === 0) return [];

  const blocks = splitByH2(text);
  const out: MarkdownChunk[] = [];
  let index = 0;

  for (const block of blocks) {
    const trimmed = block.body.trim();
    if (trimmed.length === 0) continue;
    if (block.body.length <= maxChunkChars) {
      // Apply min-size guard: drop near-empty sections that would embed
      // as noisy near-duplicate vectors. The guard only applies to whole
      // sections; oversized sections that get fixed-windowed below may
      // still produce small trailing pieces, which we filter at emit.
      if (trimmed.length < minChunkChars && options.minChunkChars === undefined) {
        continue;
      }
      out.push({ index: index++, heading: block.heading, text: trimmed });
      continue;
    }
    for (const piece of fixedWindow(block.body, maxChunkChars)) {
      if (piece.trim().length < minChunkChars && options.minChunkChars === undefined) continue;
      out.push({ index: index++, heading: block.heading, text: piece });
    }
  }

  return out;
}

// Helper used by tests to verify the centralised guard fires.
export function chunkMarkdownAllowsTiny(text: string): MarkdownChunk[] {
  return chunkMarkdown(text, { minChunkChars: 0 });
}

// Re-export so callers can reference the shared helper without importing from
// chunk-shared directly.
export { chunkIsMeaningful, MIN_CHUNK_CHARS };

interface MarkdownBlock {
  heading: string | null;
  body: string;
}

function splitByH2(text: string): MarkdownBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock = { heading: null, body: '' };
  for (const line of lines) {
    const headingMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch !== null) {
      // Only push the prior block if it has actual body content. A block
      // whose only content is its own heading line (now stripped) is a
      // template stub — embedding it produces near-duplicate vectors and
      // surfaces empty "## Heading / ## Heading" cards in the HUD.
      if (current.body.trim().length > 0) {
        blocks.push(current);
      }
      // Start a new block, recording the heading but NOT including the
      // heading line in the body. Downstream consumers (pull-files.ts)
      // re-add the heading on top of the body so the chunk's first line
      // is the heading exactly once — not twice.
      current = { heading: headingMatch[2] ?? null, body: '' };
      continue;
    }
    current.body += line + '\n';
  }
  if (current.body.trim().length > 0) {
    blocks.push(current);
  }
  return blocks;
}

// Boundary-aware fixed-window splitter. The naive char-count split lands
// inside fenced code blocks (``` ... ```) and inside multi-line bulleted
// lists, producing chunks like "```typescript\nconst x =" that strip the
// closing fence and confuse downstream consumers (Prism, the synthesizer).
// This walker picks split points at the nearest "safe" line boundary before
// the max — outside of a code fence and at a paragraph break or non-list
// line. Falls back to the original char-count split if no safe boundary
// exists within the window.
function fixedWindow(text: string, max: number): string[] {
  // First pass: split any single line longer than `max` into smaller
  // chunks so the line-aware splitter below sees only manageable lines.
  // Without this guard, a doc with one giant single-line paragraph (no
  // newlines) would never split.
  const originalLines = text.split('\n');
  const lines: string[] = [];
  for (const line of originalLines) {
    if (line.length <= max) {
      lines.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += max) {
      lines.push(line.slice(i, i + max));
    }
  }
  const out: string[] = [];
  // Track which lines sit inside a fenced code block so we know not to
  // split there. A line "starts" a fence iff it begins with three+ backticks
  // followed by optional language tag. The same pattern "ends" a fence.
  const insideFence: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.exec(line) !== null) inFence = !inFence;
    insideFence.push(inFence);
  }
  // Heuristic for "is this line a continuation of a list / blockquote / table"
  // — splitting before such lines would orphan them from their preceding
  // structure. The synth model can recover from this, but it's avoidable.
  const isListLike = (line: string): boolean =>
    /^\s*([-*+]|\d+\.|>|\|)/.test(line);

  let bufferStart = 0;
  let bufferLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i]!.length + 1; // +1 for the newline
    if (bufferLen + lineLen > max && bufferLen > 0) {
      // Need to split. Walk backwards from i to find a safe boundary.
      let cut = i;
      while (cut > bufferStart) {
        if (!insideFence[cut]! && !isListLike(lines[cut]!)) break;
        cut -= 1;
      }
      // If we couldn't find a safe boundary inside the window, just take
      // the whole oversized run — it's better to ship an oversize chunk
      // than to split inside a code fence.
      if (cut <= bufferStart) cut = i;
      const piece = lines.slice(bufferStart, cut).join('\n').trim();
      if (piece.length > 0) out.push(piece);
      bufferStart = cut;
      bufferLen = 0;
      for (let j = cut; j < i; j++) bufferLen += lines[j]!.length + 1;
    }
    bufferLen += lineLen;
  }
  // Final flush.
  const tail = lines.slice(bufferStart).join('\n').trim();
  if (tail.length > 0) out.push(tail);
  return out;
}
