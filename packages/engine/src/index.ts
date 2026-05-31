// Engine package — shared between apps/daemon (legacy, SQLite-backed) and
// the cloud surfaces (apps/portal Inngest functions, apps/bot-worker).
//
// Subpath exports are the public API:
//   @risezome/engine/chunker     — text + code chunking
//   @risezome/engine/embed       — Voyage embedder + contract
//   @risezome/engine/skills      — skill registry + GitHub skills
//   @risezome/engine/transcribe  — transcript provider contract
//
// The root re-exports the chunker and a small set of canonical types so
// most consumers can import from `@risezome/engine` directly.

export * from './chunker/index.js';
export type { CanonicalDoc, CanonicalChunk, RetrievalResult } from './types.js';
