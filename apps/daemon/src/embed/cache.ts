import { createHash } from 'node:crypto';

export interface EmbedCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface Entry {
  readonly key: string;
  readonly vector: Float32Array;
  readonly expiresAt: number;
}

export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function contentHash(text: string, domain: string): string {
  const norm = normalizeText(text);
  const hash = createHash('sha256');
  hash.update(domain);
  hash.update(':');
  hash.update(norm);
  return hash.digest('hex');
}

export class EmbedCache {
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: EmbedCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): Float32Array | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt < this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    // Refresh LRU position by re-inserting.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.vector;
  }

  set(key: string, vector: Float32Array): void {
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, {
      key,
      vector,
      expiresAt: this.#now() + this.#ttlMs,
    });
  }

  size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
