export interface CodeChunk {
  readonly index: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface ChunkCodeOptions {
  readonly chunkLines?: number;
  readonly overlapLines?: number;
}

const DEFAULT_CHUNK_LINES = 60;
const DEFAULT_OVERLAP_LINES = 12;

/**
 * Fixed-window code chunker with a small line overlap so a chunk boundary
 * does not bisect a single function. Tree-sitter symbol-aware chunking is
 * a planned follow-up; for the meeting-context use case the marginal value
 * over fixed windows is small relative to the cost of bundling N native
 * grammars.
 */
export function chunkCode(text: string, options: ChunkCodeOptions = {}): CodeChunk[] {
  const chunkLines = Math.max(1, options.chunkLines ?? DEFAULT_CHUNK_LINES);
  const overlapLines = Math.max(
    0,
    Math.min(chunkLines - 1, options.overlapLines ?? DEFAULT_OVERLAP_LINES),
  );
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0]?.length === 0)) return [];

  const chunks: CodeChunk[] = [];
  let index = 0;
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + chunkLines);
    const slice = lines.slice(start, end).join('\n').replace(/\s+$/, '');
    if (slice.length > 0) {
      chunks.push({
        index: index++,
        startLine: start + 1,
        endLine: end,
        text: slice,
      });
    }
    if (end === lines.length) break;
    start = end - overlapLines;
  }
  return chunks;
}
