// Embedder surface for both the daemon and the cloud surfaces.
// Voyage is the only production backend; the local-bge stub stays in
// apps/daemon/ because it's a daemon-only fallback for offline development.

export * from './contract.js';
export * from './voyage.js';
export { EmbedCache, contentHash } from './cache.js';
