// Canonical corpus types shared across the cloud surfaces (engine,
// bot-worker, portal) so they share the same vocabulary.

export interface CanonicalDoc {
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly title: string;
  readonly bodySummary: string;
  readonly entities: readonly string[];
  readonly authors: readonly string[];
  readonly updatedAt: number;
  readonly url?: string;
  readonly acl?: Record<string, unknown>;
  readonly provenance?: 'trusted' | 'untrusted';
}

export interface CanonicalChunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly domain: 'text' | 'code';
  readonly text: string;
  readonly position?: number;
  readonly embedding?: Float32Array;
}

export interface RetrievalResult {
  readonly doc: CanonicalDoc;
  readonly bestChunkId: string;
  readonly snippet: string;
  readonly score: number;
  readonly source: 'vector' | 'bm25' | 'hybrid';
}

export interface ConsentRecord {
  readonly providerId: string;
  readonly grantedAt: number;
  readonly grantedBy: string;
  readonly scope: string;
}
