import { describe, expect, it } from 'vitest';
import { expandToParent, type DocChunkPiece } from '../../src/parent-doc/parent-doc.js';

const opts = { capChars: 100, windowRadius: 1 };

describe('expandToParent', () => {
  it('returns the whole doc when it fits under the cap (small-to-big)', () => {
    const siblings: DocChunkPiece[] = [
      { position: 0, text: 'alpha' },
      { position: 1, text: 'bravo' },
      { position: 2, text: 'charlie' },
    ];
    const out = expandToParent({ childText: 'bravo', childPosition: 1, siblings, options: opts });
    expect(out).toBe('alpha\n\nbravo\n\ncharlie'); // full doc, in position order
  });

  it('falls back to a child +/- windowRadius window when the doc exceeds the cap', () => {
    const big = (n: number) => 'x'.repeat(18) + String(n);
    const siblings: DocChunkPiece[] = [0, 1, 2, 3, 4].map((p) => ({ position: p, text: big(p) }));
    // Whole doc is ~103 chars > cap(100); a 3-chunk window (~61) fits under it.
    const out = expandToParent({ childText: big(2), childPosition: 2, siblings, options: opts });
    expect(out).toBe([big(1), big(2), big(3)].join('\n\n'));
    expect(out).not.toContain(big(0));
    expect(out).not.toContain(big(4));
  });

  it('returns the child alone when there are no siblings', () => {
    const out = expandToParent({ childText: 'lonely', childPosition: 0, siblings: [], options: opts });
    expect(out).toBe('lonely');
  });

  it('returns the child alone when the child is not among the siblings (no linkage)', () => {
    // Oversized doc forces the window path, but childPosition has no neighbours.
    const siblings: DocChunkPiece[] = [
      { position: 10, text: 'x'.repeat(60) },
      { position: 11, text: 'y'.repeat(60) },
    ];
    const out = expandToParent({ childText: 'orphan', childPosition: 0, siblings, options: opts });
    expect(out).toBe('orphan');
  });

  it('hard-caps a window that is still too large (single oversized chunk)', () => {
    const siblings: DocChunkPiece[] = [
      { position: 0, text: 'a'.repeat(200) },
      { position: 1, text: 'b'.repeat(200) },
    ];
    const out = expandToParent({ childText: siblings[0]!.text, childPosition: 0, siblings, options: opts });
    expect(out.length).toBe(opts.capChars);
  });

  it('orders siblings by position regardless of input order', () => {
    const siblings: DocChunkPiece[] = [
      { position: 2, text: 'third' },
      { position: 0, text: 'first' },
      { position: 1, text: 'second' },
    ];
    const out = expandToParent({ childText: 'first', childPosition: 0, siblings, options: opts });
    expect(out).toBe('first\n\nsecond\n\nthird');
  });
});
