import { describe, expect, it } from 'vitest';
import { EmbedCache, contentHash, normalizeText } from '../../src/embed/cache.js';

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('normalizeText', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeText('  Hello    World\n')).toBe('hello world');
  });
});

describe('contentHash', () => {
  it('hashes normalized text + domain', () => {
    const a = contentHash('Hello World', 'text');
    const b = contentHash('  hello   world  ', 'text');
    expect(a).toBe(b);
  });

  it('differs by domain', () => {
    const a = contentHash('hello', 'text');
    const b = contentHash('hello', 'code');
    expect(a).not.toBe(b);
  });
});

describe('EmbedCache', () => {
  it('hits on identical content', () => {
    const cache = new EmbedCache();
    cache.set('k', vec(1, 0));
    expect(cache.get('k')).not.toBeNull();
  });

  it('misses on absent key', () => {
    const cache = new EmbedCache();
    expect(cache.get('missing')).toBeNull();
  });

  it('respects max entries (LRU eviction)', () => {
    const cache = new EmbedCache({ maxEntries: 3 });
    cache.set('a', vec(1));
    cache.set('b', vec(2));
    cache.set('c', vec(3));
    cache.set('d', vec(4));
    expect(cache.size()).toBe(3);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('d')).not.toBeNull();
  });

  it('promotes recently-accessed keys to LRU tail', () => {
    const cache = new EmbedCache({ maxEntries: 3 });
    cache.set('a', vec(1));
    cache.set('b', vec(2));
    cache.set('c', vec(3));
    expect(cache.get('a')).not.toBeNull();
    cache.set('d', vec(4));
    // 'b' is now oldest and evicted.
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).not.toBeNull();
  });

  it('expires entries past TTL', () => {
    let now = 1000;
    const cache = new EmbedCache({ ttlMs: 100, now: () => now });
    cache.set('k', vec(1));
    expect(cache.get('k')).not.toBeNull();
    now += 200;
    expect(cache.get('k')).toBeNull();
  });
});
