// File chunker for the cloud indexer (U5c).
//
// Given a file's `path` + `text` content, produce a sequence of chunks
// suitable for embedding. Each chunk is `{ domain, text, position }` where
// domain selects the embedding model downstream (text → voyage-3-large,
// code → voyage-code-3).
//
// The chunker is intentionally simple and deterministic for V1:
//   - Domain detection by extension. Code-like extensions → 'code'; the
//     rest fall back to 'text'. The blocklist short-circuits binary files
//     before any line scanning.
//   - Line-based chunking with overlap. Code chunks are larger (more
//     context needed to understand a function) but the same algorithm
//     applies to both domains — keeps the implementation easy to reason
//     about and lets us tune one knob.
//   - Output is ordered by `position`, starting at 0.
//
// Not in V1 (deferred when needed):
//   - AST-aware code chunking (tree-sitter): worth the complexity only
//     when retrieval-quality measurements show line-based chunks hurting
//     code-search results.
//   - Token-counted chunks: line counts are a good proxy for embedding
//     budget at our chunk sizes; switch to tokens if Voyage starts
//     truncating non-trivially.

import type { CanonicalChunk } from '../types.js';

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'scala',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp',
  'cs', 'php', 'swift', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'proto',
  'css', 'scss', 'sass', 'less',
  'html', 'vue', 'svelte', 'astro',
  'yaml', 'yml', 'toml', 'json', 'jsonc',
  'dockerfile', 'tf', 'hcl',
]);

const TEXT_EXTENSIONS = new Set([
  'md', 'mdx', 'rst', 'txt', 'adoc', 'org',
]);

// Hard blocklist — never index these even if they slipped past the
// caller's filtering. Keeps the embedder from wasting budget on noise.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi', 'mkv',
  'pdf', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'wasm',
  'pyc', 'pyo', 'whl', 'egg',
  'lock', // pnpm-lock.yaml is text but huge + low value
]);

// Filenames that mean "code" even though they have no extension.
const FILENAME_HINTS_CODE = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile',
  'jenkinsfile', 'vagrantfile', 'cmakelists.txt',
]);

export interface FileChunkerOptions {
  /** Lines per chunk for text files. Default 80. */
  textChunkLines?: number;
  /** Lines per chunk for code files. Default 120. */
  codeChunkLines?: number;
  /** Lines of overlap between adjacent chunks. Default 20. */
  overlapLines?: number;
  /** Skip files larger than this many bytes. Default 512 KB. */
  maxFileBytes?: number;
}

const DEFAULTS: Required<FileChunkerOptions> = {
  textChunkLines: 80,
  codeChunkLines: 120,
  overlapLines: 20,
  maxFileBytes: 512 * 1024,
};

/**
 * Returns 'text', 'code', or null. Null means: skip this file entirely
 * (binary, unrecognized, or filename-blocked).
 */
export function classifyFile(path: string): 'text' | 'code' | null {
  const filename = baseName(path).toLowerCase();
  if (FILENAME_HINTS_CODE.has(filename)) return 'code';

  const ext = extOf(filename);
  if (ext === null) return null;
  if (BINARY_EXTENSIONS.has(ext)) return null;
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

/**
 * Chunk a single file into ordered chunks. Returns [] if the file should
 * be skipped (binary, oversized, empty, unclassifiable).
 *
 * Caller is responsible for assigning chunk_id; we return the
 * non-identifying fields (domain, text, position) so the caller can build
 * `${docId}::${position}` ids that match the migration's convention.
 */
export function chunkFile(
  path: string,
  content: string,
  options: FileChunkerOptions = {},
): Pick<CanonicalChunk, 'domain' | 'text' | 'position'>[] {
  const opts = { ...DEFAULTS, ...options };

  const domain = classifyFile(path);
  if (domain === null) return [];

  // Byte count is an approximation (utf-16 vs utf-8); good enough for the
  // oversized-file guard. Tightening to utf-8 byte count is a microopt.
  if (content.length > opts.maxFileBytes) return [];
  if (content.length === 0) return [];

  const lines = content.split(/\r?\n/);
  if (lines.length === 0) return [];

  const linesPerChunk = domain === 'code' ? opts.codeChunkLines : opts.textChunkLines;
  const overlap = Math.min(opts.overlapLines, Math.max(0, linesPerChunk - 1));
  const stride = Math.max(1, linesPerChunk - overlap);

  const out: Pick<CanonicalChunk, 'domain' | 'text' | 'position'>[] = [];
  let position = 0;
  for (let start = 0; start < lines.length; start += stride) {
    const slice = lines.slice(start, start + linesPerChunk);
    const text = slice.join('\n').trim();
    if (text.length === 0) continue;
    out.push({ domain, text, position });
    position += 1;
    // If this chunk reached EOF, stop — no point starting an overlap
    // chunk that would re-emit the same trailing lines.
    if (start + linesPerChunk >= lines.length) break;
  }
  return out;
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function extOf(filename: string): string | null {
  const i = filename.lastIndexOf('.');
  if (i === -1 || i === 0) return null;
  return filename.slice(i + 1);
}
