import { describe, expect, it } from 'vitest';
import { dedupeByDoc } from '../src/parent-doc';

describe('dedupeByDoc', () => {
  it('keeps the first (best-ranked) occurrence per docId, preserving order', () => {
    const hits = [
      { id: 'a', doc: 'docA' },
      { id: 'b', doc: 'docB' },
      { id: 'c', doc: 'docA' }, // dup of docA, dropped
      { id: 'd', doc: 'docC' },
      { id: 'e', doc: 'docB' }, // dup of docB, dropped
    ];
    const out = dedupeByDoc(hits, (h) => h.doc);
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'd']);
  });

  it('keeps items whose docId cannot be resolved (undefined)', () => {
    const hits = [
      { id: 'a', doc: undefined },
      { id: 'b', doc: 'docA' },
      { id: 'c', doc: undefined },
      { id: 'd', doc: 'docA' }, // dropped
    ];
    const out = dedupeByDoc(hits, (h) => h.doc);
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op when every item is a distinct doc', () => {
    const hits = [{ id: 'a', doc: 'x' }, { id: 'b', doc: 'y' }];
    expect(dedupeByDoc(hits, (h) => h.doc)).toHaveLength(2);
  });

  it('handles an empty list', () => {
    expect(dedupeByDoc([], () => 'x')).toEqual([]);
  });
});
