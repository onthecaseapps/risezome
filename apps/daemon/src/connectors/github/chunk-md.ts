export interface MarkdownChunk {
  readonly index: number;
  readonly heading: string | null;
  readonly text: string;
}

export interface ChunkMarkdownOptions {
  readonly maxChunkChars?: number;
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
  if (text.trim().length === 0) return [];

  const blocks = splitByH2(text);
  const out: MarkdownChunk[] = [];
  let index = 0;

  for (const block of blocks) {
    const trimmed = block.body.trim();
    if (trimmed.length === 0) continue;
    if (block.body.length <= maxChunkChars) {
      out.push({ index: index++, heading: block.heading, text: trimmed });
      continue;
    }
    for (const piece of fixedWindow(block.body, maxChunkChars)) {
      out.push({ index: index++, heading: block.heading, text: piece });
    }
  }

  return out;
}

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
      if (current.body.trim().length > 0 || current.heading !== null) {
        blocks.push(current);
      }
      current = { heading: headingMatch[2] ?? null, body: line + '\n' };
      continue;
    }
    current.body += line + '\n';
  }
  if (current.body.trim().length > 0 || current.heading !== null) {
    blocks.push(current);
  }
  return blocks;
}

function fixedWindow(text: string, max: number): string[] {
  const out: string[] = [];
  const step = Math.max(1, Math.floor(max * 0.85));
  for (let i = 0; i < text.length; i += step) {
    const piece = text.slice(i, i + max).trim();
    if (piece.length > 0) out.push(piece);
  }
  return out;
}
