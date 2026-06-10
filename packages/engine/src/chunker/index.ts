// Chunking + text-heuristics surface.
//
// Two consumers today:
//   - The indexer (U5c) uses chunkFile + classifyFile to turn raw file
//     bytes from GitHub into embedding-shaped chunks.
//   - The retrieval pipeline (apps/bot-worker) uses the text-heuristics
//     helpers (hasEntityLikeToken, buildFtsQuery) for query rewriting +
//     hybrid retrieval.

export { chunkFile, classifyFile, type FileChunkerOptions } from './file-chunker.js';
export { type Dialect, dialectForExt, findUnitBoundaries } from './code-structure.js';
export {
  tokenize,
  stripStopwords,
  hasEntityLikeToken,
  escapeFtsTerm,
  buildFtsQuery,
} from './text-heuristics.js';
